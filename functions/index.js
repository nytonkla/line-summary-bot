// index.js
// Firebase Functions version of LINE Summary Bot
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Firebase Admin SDK lazily
let dbInstance = null;
function getDb() {
  if (!dbInstance) {
    if (!admin.apps.length) {
      try {
        const serviceAccount = require('./serviceAccountKey.json');
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      } catch (e) {
        admin.initializeApp();
      }
    }
    dbInstance = admin.firestore();
  }
  return dbInstance;
}

const db = new Proxy({}, {
  get: (_, prop) => {
    const instance = getDb();
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});

// Initialize Google AI (Gemini) lazily
let genAI, modelInstance;
function getModel() {
  if (!modelInstance && process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    modelInstance = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });
  }
  return modelInstance;
}

// Global variable to store Google Sheets data
let cachedSheetsData = [];

// Function to split long text into multiple messages (LINE has 5000 char limit per message)
function splitIntoMessages(text, maxLength = 4000) {
  if (!text) return [];
  const messages = [];
  const lines = text.split('\n');
  let currentMessage = '';
  
  for (let line of lines) {
    // If an individual line exceeds maxLength, chunk it into smaller parts
    while (line.length > maxLength) {
      let breakIndex = line.lastIndexOf(' ', maxLength);
      if (breakIndex <= 0) breakIndex = maxLength;
      
      const part = line.substring(0, breakIndex);
      line = line.substring(breakIndex).trimStart();
      
      if (currentMessage.length + part.length + 1 > maxLength && currentMessage.length > 0) {
        messages.push(currentMessage.trim());
        currentMessage = part;
      } else {
        currentMessage += (currentMessage.length > 0 ? '\n' : '') + part;
      }
    }

    if (currentMessage.length + line.length + 1 > maxLength && currentMessage.length > 0) {
      messages.push(currentMessage.trim());
      currentMessage = line;
    } else {
      currentMessage += (currentMessage.length > 0 ? '\n' : '') + line;
    }
  }
  
  if (currentMessage.trim().length > 0) {
    messages.push(currentMessage.trim());
  }
  
  return messages;
}

// Function to safely send text messages to LINE in batches of max 5 message objects (LINE API limit)
async function sendLineMessages(client, replyToken, targetId, textArray) {
  if (!textArray || textArray.length === 0) return;
  
  const messageObjects = textArray.map(text => ({
    type: 'text',
    text: text
  }));
  
  const batchSize = 5; // LINE API allows at most 5 message objects per request
  let replyTokenUsed = false;
  
  for (let i = 0; i < messageObjects.length; i += batchSize) {
    const chunk = messageObjects.slice(i, i + batchSize);
    
    if (!replyTokenUsed && replyToken) {
      try {
        await client.replyMessage(replyToken, chunk);
        replyTokenUsed = true;
      } catch (replyError) {
        console.error('Error replying to LINE (falling back to pushMessage):', replyError.message);
        if (targetId) {
          await client.pushMessage(targetId, chunk);
        }
      }
    } else if (targetId) {
      await client.pushMessage(targetId, chunk);
    }
  }
}

// Rate limiting utility
class RateLimiter {
  constructor(maxRequests = 2, windowMs = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async waitForSlot() {
    const now = Date.now();
    
    // Remove old requests outside the window
    this.requests = this.requests.filter(time => now - time < this.windowMs);
    
    // If we're at the limit, wait until the oldest request expires
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      if (waitTime > 0) {
        console.log(`Rate limit reached. Waiting ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.waitForSlot(); // Recursively check again
      }
    }
    
    // Record this request
    this.requests.push(now);
  }
}

// Create a global rate limiter for Gemini API calls
// Gemini 2.0 Flash has 15 RPM limit, so we'll use 14 requests per minute to be safe
const geminiRateLimiter = new RateLimiter(14, 60000); // Max 14 requests per 60 seconds (1 minute)

// Enhanced function to generate content with retry logic and rate limiting
async function generateContentWithRetry(prompt, maxRetries = 5) {
  const model = getModel();
  if (!model) {
    throw new Error('Gemini model not initialized. Please check GEMINI_API_KEY environment variable.');
  }
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Wait for rate limiter
      await geminiRateLimiter.waitForSlot();
      
      console.log(`Generating content (attempt ${attempt}/${maxRetries})...`);
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      console.log(`Content generated successfully on attempt ${attempt}`);
      return text;
      
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      // Check if it's a rate limit error
      if (error.message && (
        error.message.includes('429') || 
        error.message.includes('TooManyRequests') ||
        error.message.includes('quota') ||
        error.message.includes('rate limit')
      )) {
        if (attempt < maxRetries) {
          // Exponential backoff with jitter: wait (2^attempt * 2000) + random_jitter ms
          const waitTime = Math.pow(2, attempt) * 2000 + Math.floor(Math.random() * 1000);
          console.log(`Rate limit hit. Waiting ${waitTime}ms before retry ${attempt + 1}...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        } else {
          throw new Error(`Rate limit exceeded after ${maxRetries} attempts. Please try again later.`);
        }
      } else {
        // For non-rate-limit errors, throw immediately
        throw error;
      }
    }
  }
}

// Function to process chats in batches and send multiple reply messages
async function processChatsInBatches(client, event, chats, lastSummaryTimestamp, batchSize = 15) {
  const totalChats = chats.length;
  console.log(`Processing ${totalChats} chats in batches of ${batchSize}`);
  
  let anySummarySent = false;
  // Process chats in batches
  for (let i = 0; i < totalChats; i += batchSize) {
    const batch = chats.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(totalChats / batchSize);
    
    console.log(`Processing batch ${batchNumber}/${totalBatches} with ${batch.length} chats`);
    
    const summaries = [];
    
    // Process each chat in the current batch
    for (const chatDoc of batch) {
      const chatId = chatDoc.id;
      
      // Get messages from this chat
      const limit = lastSummaryTimestamp ? 100 : 30;
      const messagesSnapshot = await db.collection('chats')
        .doc(chatId)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

      console.log(`Found ${messagesSnapshot.size} messages in chat ${chatId}`);
      if (messagesSnapshot.empty) continue;

      // Convert to array and reverse to get chronological order
      let messages = messagesSnapshot.docs
        .map(doc => doc.data())
        .reverse()
        .filter(msg => msg.text && msg.text.toLowerCase() !== '/sumgroup');

      // Filter messages based on last summary timestamp
      if (lastSummaryTimestamp) {
        messages = messages.filter(msg => {
          if (!msg.timestamp) return false;
          return msg.timestamp.toDate() > lastSummaryTimestamp.toDate();
        });
        console.log(`After filtering by timestamp: ${messages.length} messages remain in chat ${chatId}`);
      } else {
        messages = messages.slice(-30);
        console.log(`No previous summary found, taking last 30 messages: ${messages.length} messages in chat ${chatId}`);
      }

      if (messages.length === 0) continue;

      // Get chat info
      const firstMessage = messages[0];
      const chatType = firstMessage.chatsType;
      
      // Skip user/direct chats - only process group chats
      if (chatType !== 'group') {
        console.log(`Skipping ${chatType} chat - only processing group chats`);
        continue;
      }
      
      const chatName = firstMessage.groupName || 'Unknown Group';

      console.log(`Generating summary for ${chatType}: ${chatName}`);

      // Create conversation text for this chat with safe message length limits
      let conversationText = messages
        .map(msg => {
          const text = msg.text || '';
          const safeText = text.length > 2000 ? text.substring(0, 2000) + '... (truncated)' : text;
          return `${msg.displayName || 'User'}: ${safeText}`;
        })
        .join('\n');

      if (conversationText.length > 30000) {
        console.log(`Conversation text too long (${conversationText.length} chars), truncating to last 30000 chars`);
        conversationText = '... (earlier messages truncated)\n' + conversationText.substring(conversationText.length - 30000);
      }

      // Generate summary for this chat
      const summaryPrompt = `Summarize the key points and action items from the following group chat conversation, with additional focusing exclusively on anything relevant to the user Kla.
If and only if Kla or any of his aliases are mentioned, provide a brief, bulleted list of the key points, questions, or action items directed at him.
Kla is mentioned using these names: @kla, @klawisesight, กล้า, or kla.
Do not add any headlines, introductory sentences. Chat Conversation to Summarize: "${chatName}":\n\n${conversationText}\n\nSummary:`;
      const summary = await generateContentWithRetry(summaryPrompt);

      summaries.push(`📝 **${chatType} : ${chatName}**\n${summary}`);
    }
    
    // Send batch summary if there are summaries
    if (summaries.length > 0) {
      anySummarySent = true;
      const batchTitle = totalBatches > 1 ? ` (Batch ${batchNumber}/${totalBatches})` : '';
      const combinedSummary = summaries.join('\n----\n');
      
      // Split the summary into multiple messages if it's too long
      const summaryMessages = splitIntoMessages(`📋 **Conversation Summaries${batchTitle}**\n\n${combinedSummary}`);
      
      const targetId = event.source.groupId || event.source.userId;
      const replyToken = batchNumber === 1 ? event.replyToken : null;
      await sendLineMessages(client, replyToken, targetId, summaryMessages);
      
      // Add a 1-minute delay between batches to respect RPM limits
      if (i + batchSize < totalChats) {
        console.log(`Waiting 1 minute (60 seconds) before processing next batch to respect RPM limits...`);
        await new Promise(resolve => setTimeout(resolve, 60000)); // 60 seconds = 1 minute
      }
    }
  }
  
  if (!anySummarySent) {
    console.log('No new messages found to summarize since the last check.');
    await sendLineMessages(client, event.replyToken, null, ['📋 No new messages found to summarize since the last check!']);
  }
  
  console.log(`Completed processing all ${totalChats} chats`);
}

// Function to process collection group chats in batches
async function processCollectionGroupChatsInBatches(client, event, chatEntries, lastSummaryTimestamp, batchSize = 15) {
  const totalChats = chatEntries.length;
  console.log(`Processing ${totalChats} collection group chats in batches of ${batchSize}`);
  
  let anySummarySent = false;
  // Process chats in batches
  for (let i = 0; i < totalChats; i += batchSize) {
    const batch = chatEntries.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(totalChats / batchSize);
    
    console.log(`Processing collection group batch ${batchNumber}/${totalBatches} with ${batch.length} chats`);
    
    const summaries = [];
    
    // Process each chat in the current batch
    for (const [chatId, messages] of batch) {
      console.log(`Processing chat ${chatId} with ${messages.length} messages`);
      
      // Filter messages based on last summary timestamp
      let filteredMessages = messages.filter(msg => msg.text && msg.text.toLowerCase() !== '/sumgroup');
      
      if (lastSummaryTimestamp) {
        // Filter messages after the last summary timestamp
        filteredMessages = filteredMessages.filter(msg => {
          if (!msg.timestamp) return false;
          return msg.timestamp.toDate() > lastSummaryTimestamp.toDate();
        });
        console.log(`After filtering by timestamp: ${filteredMessages.length} messages remain`);
      } else {
        // If no previous summary, take last 30 messages
        filteredMessages = filteredMessages
          .sort((a, b) => {
            const timeA = a.timestamp?.toDate?.() || new Date(0);
            const timeB = b.timestamp?.toDate?.() || new Date(0);
            return timeA - timeB;
          })
          .slice(-30);
        console.log(`No previous summary found, taking last 30 messages: ${filteredMessages.length} messages`);
      }
      
      if (filteredMessages.length === 0) {
        console.log('No messages after filtering, skipping this chat');
        continue;
      }
      
      const firstMessage = filteredMessages[0];
      const chatType = firstMessage.chatsType;
      
      // Skip user/direct chats - only process group chats
      if (chatType !== 'group') {
        console.log(`Skipping ${chatType} chat - only processing group chats`);
        continue;
      }
      
      const chatName = firstMessage.groupName || 'Unknown Group';
      
      console.log(`Generating summary for ${chatType}: ${chatName}...`);
      
      let conversationText = filteredMessages
        .map(msg => {
          const text = msg.text || '';
          const safeText = text.length > 2000 ? text.substring(0, 2000) + '... (truncated)' : text;
          return `${msg.displayName || 'User'}: ${safeText}`;
        })
        .join('\n');
      
      if (conversationText.length > 30000) {
        console.log(`Conversation text too long (${conversationText.length} chars), truncating to last 30000 chars`);
        conversationText = '... (earlier messages truncated)\n' + conversationText.substring(conversationText.length - 30000);
      }
      
      const summaryPrompt = `Summarize the following group chat conversation. Your primary objective is to create a summary specifically for a user named Kla. It is critical to highlight all direct mentions, questions, and action items assigned to him so he doesn't miss anything important. 
      Key Persona to Focus On:
      Kla is mentioned using these names: @kla, @klawisesight, กล้า, or kla.
      Required Output Structure:
      1. General Summary: Provide a brief, 2-3 sentence paragraph outlining the main topics and overall sentiment of the conversation.
      2. Mentions & Action Items for Kla: Create a dedicated, bulleted list for every instance where Kla was mentioned. For each bullet point, clearly state: The context of the mention. Who made the mention. Any direct questions or action items for Kla. Chat Conversation to Summarize: "${chatName}":\n\n${conversationText}\n\nSummary:`;
      const summary = await generateContentWithRetry(summaryPrompt);
      console.log(`Summary generated for ${chatType}: ${chatName}: ${summary.substring(0, 100)}...`);
      
      summaries.push(`📝 **${chatType} : ${chatName}**\n${summary}\n`);
    }
    
    // Send batch summary if there are summaries
    if (summaries.length > 0) {
      anySummarySent = true;
      const batchTitle = totalBatches > 1 ? ` (Batch ${batchNumber}/${totalBatches})` : '';
      const combinedSummary = summaries.join('----------\n');
      
      // Split the summary into multiple messages if it's too long
      const summaryMessages = splitIntoMessages(`📋 **Conversation Summaries${batchTitle}**\n\n${combinedSummary}`);
      
      const targetId = event.source.groupId || event.source.userId;
      const replyToken = batchNumber === 1 ? event.replyToken : null;
      await sendLineMessages(client, replyToken, targetId, summaryMessages);
      
      // Add a 1-minute delay between batches to respect RPM limits
      if (i + batchSize < totalChats) {
        console.log(`Waiting 1 minute (60 seconds) before processing next batch to respect RPM limits...`);
        await new Promise(resolve => setTimeout(resolve, 60000)); // 60 seconds = 1 minute
      }
    }
  }
  
  if (!anySummarySent) {
    console.log('No new messages found to summarize since the last check.');
    await sendLineMessages(client, event.replyToken, null, ['📋 No new messages found to summarize since the last check!']);
  }
  
  console.log(`Completed processing all ${totalChats} collection group chats`);
}

// Function to save message to database and return document reference
async function saveMessageToDatabase(event, client) {
  try {
    // Determine the chats ID (group ID or user ID)
    const chatsId = event.source.groupId || event.source.userId;
    const chatsType = event.source.groupId ? 'group' : 'user';
    
    // Get user profile (display name) and group name
    let displayName = 'Unknown User';
    let groupName = null;
    try {
      if (chatsType === 'group') {
        // Get group member profile
        const profile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
        displayName = profile.displayName;
        
        // Get group summary (group name)
        try {
          const groupSummary = await client.getGroupSummary(event.source.groupId);
          groupName = groupSummary.groupName;
        } catch (groupError) {
          console.error('Error getting group name:', groupError);
          groupName = 'Unknown Group';
        }
      } else {
        // Get user profile
        const profile = await client.getProfile(event.source.userId);
        displayName = profile.displayName;
      }
    } catch (profileError) {
      console.error('Error getting user profile:', profileError);
      // Keep default displayName if profile fetch fails
    }
    
    // Write message data to Firestore
    const messageData = {
      messageId: event.message.id,
      text: event.message.text,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      eventType: event.type,
      messageType: event.message.type,
      userId: event.source.userId,
      displayName: displayName,
      groupName: groupName,
      chatsId: chatsId,
      chatsType: chatsType,
      responseType: null // Default: no response from bot
    };

    // Add to Firestore collection, grouped by chats
    console.log(`Attempting to save message to Firestore for ${chatsType} ${chatsId} from ${displayName}`);
    
    // First, ensure the chat document exists
    const chatDocRef = db.collection('chats').doc(chatsId);
    await chatDocRef.set({
      chatsId: chatsId,
      chatsType: chatsType,
      groupName: groupName,
      lastActivity: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log(`Chat document ensured for ${chatsId}`);
    
    // Then add the message
    const docRef = await chatDocRef
      .collection('messages')
      .add(messageData);
    console.log(`Message saved successfully with ID: ${docRef.id}`);
    
    console.log(`Message saved to Firestore for ${chatsType} from ${displayName}:`, messageData.text);
    return docRef;
    
  } catch (error) {
    console.error('Error saving message to database:', error);
    return null;
  }
}

// Function to get the last summary timestamp from commands collection
async function getLastSummaryTimestamp(commandText = '/sumgroup') {
  try {
    const commandsSnapshot = await db.collection('commands')
      .where('commandText', '==', commandText)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    
    if (!commandsSnapshot.empty) {
      const lastCommand = commandsSnapshot.docs[0].data();
      return lastCommand.timestamp;
    }
    return null;
  } catch (error) {
    console.error('Error getting last summary timestamp:', error);
    return null;
  }
}

// Function to check if text is similar to any code in the database
function checkCodeSimilarity(text, codes) {
  try {
    const trimmedText = text.trim().toLowerCase();
    
    // If no codes available, return "no"
    if (!codes || codes.length === 0) {
      return "no";
    }
    
    // Check if the text is a substring of any code (case-insensitive)
    for (const codeEntry of codes) {
      if (codeEntry.code && codeEntry.code.trim().toLowerCase().includes(trimmedText)) {
        return "yes";
      }
    }
    
    return "no";
  } catch (error) {
    console.error('Error checking code similarity:', error);
    return "no";
  }
}

// Function to query direct messages from database
async function queryDirectMessages(lastTimestamp, limit = 100) {
  try {
    console.log('Querying direct messages...');
    
    // First, get all chats that are user chats
    const chatsSnapshot = await db.collection('chats')
      .where('chatsType', '==', 'user')
      .get();
    
    console.log(`Found ${chatsSnapshot.size} user chats`);
    
    if (chatsSnapshot.empty) {
      console.log('No user chats found');
      return [];
    }
    
    const messages = [];
    let totalQueried = 0;
    
    // Query messages from each user chat
    for (const chatDoc of chatsSnapshot.docs) {
      const chatId = chatDoc.id;
      
      let query = db.collection('chats')
        .doc(chatId)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(25); // Reduced limit per chat to avoid API overload
      
      // Filter by timestamp if provided
      if (lastTimestamp) {
        query = query.where('timestamp', '>', lastTimestamp);
      }
      
      const messagesSnapshot = await query.get();
      console.log(`Found ${messagesSnapshot.size} messages in chat ${chatId}`);
      
      for (const doc of messagesSnapshot.docs) {
        const data = doc.data();
        
        // Only process messages that are not commands
        if (data.text && !data.text.startsWith('/')) {
          // Check if message has responseType "code replied" or if text is similar to any code
          const isCode = data.responseType === "code replied" ? "yes" : checkCodeSimilarity(data.text || '', cachedSheetsData);
          
          messages.push({
            timestamp: data.timestamp,
            displayName: data.displayName || 'Unknown User',
            text: data.text || '',
            is_code: isCode
          });
          
          totalQueried++;
          
          // Stop if we've reached the limit
          if (totalQueried >= limit) {
            break;
          }
        }
      }
      
      // Stop if we've reached the limit
      if (totalQueried >= limit) {
        break;
      }
    }
    
    // Sort by timestamp ascending (oldest first) for chronological order
    messages.sort((a, b) => {
      const timeA = a.timestamp?.toDate?.() || new Date(0);
      const timeB = b.timestamp?.toDate?.() || new Date(0);
      return timeA - timeB;
    });
    
    console.log(`Processed ${messages.length} direct messages with code matching`);
    return messages;
    
  } catch (error) {
    console.error('Error querying direct messages:', error);
    return [];
  }
}

// Function to generate AI summary for direct messages
async function generateDirectMessageSummary(messages) {
  try {
    if (!messages || messages.length === 0) {
      return "No direct messages found to analyze.";
    }
    
    console.log(`Generating AI summary for ${messages.length} direct messages...`);
    
    // Create a formatted string of messages for the AI prompt
    // Limit the total text length to prevent API overload
    let messagesText = messages.map((msg, index) => {
      const timestamp = msg.timestamp?.toDate?.()?.toLocaleString() || 'Unknown time';
      // Truncate very long messages to prevent API overload
      const truncatedText = msg.text.length > 200 ? msg.text.substring(0, 200) + '...' : msg.text;
      return `${index + 1}. [${timestamp}] ${msg.displayName}: "${truncatedText}" (is_code: ${msg.is_code})`;
    }).join('\n');
    
    // If the total text is too long, truncate it further
    if (messagesText.length > 8000) {
      console.log(`Message text too long (${messagesText.length} chars), truncating to 8000 chars`);
      messagesText = messagesText.substring(0, 8000) + '\n... (truncated due to length)';
    }
    
    const prompt = `Analyze these direct messages and return ONLY a valid JSON object with the following structure:
{
  "total_direct_messages": <number>,
  "messages_with_code": <number>,
  "needs_response": [{"text": "<text>", "reason": "question|request|complaint"}],
  "no_response_needed": {
    "greeting_count": <number>,
    "thank_you_count": <number>,
    "acknowledgement_count": <number>,
    "other_count": <number>
  }
}

Rules:
- Count total direct messages
- For messages_with_code: count the number of messages where is_code is "yes" (do not show text)
- messages_with_code is neither needs_response nor no_response_needed
- For needs_response: identify messages that require a response (questions, requests, complaints)
- For no_response_needed: count messages that don't need response (greetings, thanks, acknowledgments, other) - do not show text, just count
- Only include the JSON object, no other text

Messages to analyze:
${messagesText}`;

    const aiResponse = await generateContentWithRetry(prompt);
    console.log('AI response received:', aiResponse.substring(0, 200) + '...');
    
    // Parse JSON response
    let analysis;
    try {
      // Extract JSON from response (in case AI adds extra text)
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Error parsing AI response:', parseError);
      return `Error parsing AI analysis. Raw response: ${aiResponse}`;
    }
    
    // Format the analysis into a readable message
    let summary = `📊 **Direct Messages Summary**\n\n`;
    summary += `📝 **Total Direct Messages:** ${analysis.total_direct_messages || 0}\n\n`;
    
    if (analysis.messages_with_code && analysis.messages_with_code > 0) {
      summary += `🔢 **Messages with Code:** ${analysis.messages_with_code} message(s)\n\n`;
    }
    
    if (analysis.needs_response && analysis.needs_response.length > 0) {
      summary += `❓ **Messages Needing Response:**\n`;
      analysis.needs_response.forEach(item => {
        summary += `• "${item.text}" (${item.reason})\n`;
      });
      summary += `\n`;
    }
    
    if (analysis.no_response_needed) {
      const noResponse = analysis.no_response_needed;
      const totalNoResponse = (noResponse.greeting_count || 0) + (noResponse.thank_you_count || 0) + 
                             (noResponse.acknowledgement_count || 0) + (noResponse.other_count || 0);
      
      if (totalNoResponse > 0) {
        summary += `✅ **Messages Not Needing Response:** ${totalNoResponse} message(s)\n`;
        if (noResponse.greeting_count > 0) {
          summary += `• Greetings: ${noResponse.greeting_count}\n`;
        }
        if (noResponse.thank_you_count > 0) {
          summary += `• Thank you: ${noResponse.thank_you_count}\n`;
        }
        if (noResponse.acknowledgement_count > 0) {
          summary += `• Acknowledgements: ${noResponse.acknowledgement_count}\n`;
        }
        if (noResponse.other_count > 0) {
          summary += `• Other: ${noResponse.other_count}\n`;
        }
      }
    }
    
    return summary;
    
  } catch (error) {
    console.error('Error generating direct message summary:', error);
    return `Error generating summary: ${error.message}`;
  }
}

// Function to fetch data from Google Sheets and update cache
async function fetchGoogleSheetsData() {
  try {
    console.log('Fetching data from Google Sheets...');
    
    // Extract spreadsheet ID from the URL
    const url = process.env.KLA_DOWNLOAD_CODE_URL;
    const spreadsheetId = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    
    if (!spreadsheetId) {
      throw new Error('Could not extract spreadsheet ID from URL');
    }
    
    console.log('Spreadsheet ID:', spreadsheetId);
    
    // Initialize Google Sheets API (using API key for public sheets)
    const { google } = require('googleapis');
    const sheets = google.sheets({ version: 'v4', auth: process.env.GOOGLE_API_KEY });
    
    // Fetch data from the sheet with timeout and comprehensive error handling
    let response;
    try {
      response = await Promise.race([
        sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId,
          range: 'A:C', // Get columns A, B, C (status, code, link)
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Google Sheets API timeout')), 10000)
        )
      ]);
    } catch (apiError) {
      // Re-throw the error to be caught by the outer try-catch
      throw apiError;
    }
    
    const rows = response.data.values;
    console.log(`Fetched ${rows.length} rows from Google Sheets`);
    
    // Convert to array of objects
    const data = rows.slice(1).map((row, index) => ({
      row: index + 2, // Excel row number (accounting for header)
      status: row[0] || '',
      code: row[1] || '',
      link: row[2] || ''
    }));
    
    // Update the global cache
    cachedSheetsData = data;
    console.log(`Updated cached sheets data with ${data.length} entries`);
    
    return data;
  } catch (error) {
    console.error('Error fetching Google Sheets data:', error);
    
    // Check for different types of errors
    if (error.message && error.message.includes('blocked')) {
      console.log('Google Sheets API is blocked. Using cached data or fallback data.');
    } else if (error.message && error.message.includes('403')) {
      console.log('Google Sheets API access denied (403). Using cached data or fallback data.');
    } else if (error.message && error.message.includes('quota')) {
      console.log('Google Sheets API quota exceeded. Using cached data or fallback data.');
    } else {
      console.log('Unknown Google Sheets API error. Using cached data or fallback data.');
    }
    
    // Return cached data if available, otherwise return empty array
    if (cachedSheetsData.length > 0) {
      console.log(`Returning ${cachedSheetsData.length} cached entries`);
      return cachedSheetsData;
    } else {
      console.log('No cached data available, returning empty array');
      return [];
    }
  }
}

// --- 1. SET UP YOUR CONFIGURATION ---
// Get your Channel Access Token and Channel Secret from environment variables
let config, client;
if (process.env.CHANNEL_ACCESS_TOKEN && process.env.CHANNEL_SECRET) {
  config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
  };
  
  // Create a new LINE SDK client
  client = new line.Client(config);
}

// Create an Express application
const app = express();

// --- 2. ADD CODE ENDPOINTS ---
// Endpoint to display cached code data
app.get('/code', async (req, res) => {
  try {
    res.json({
      message: 'Code Data (Cached)',
      totalRows: cachedSheetsData.length,
      data: cachedSheetsData,
      note: 'Data is cached at startup. Use /codeupdate to update.'
    });
  } catch (error) {
    console.error('Error in /code endpoint:', error);
    res.status(500).json({
      error: 'Failed to get cached code data',
      details: error.message
    });
  }
});

// Endpoint to refetch and update code data
app.get('/codeupdate', async (req, res) => {
  try {
    console.log('Manual refetch of code data requested...');
    const sheetsData = await fetchGoogleSheetsData();
    res.json({
      message: 'Code Data Refetched Successfully',
      totalRows: sheetsData.length,
      data: sheetsData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /codeupdate endpoint:', error);
    res.status(500).json({
      error: 'Failed to refetch code data',
      details: error.message
    });
  }
});

// --- 3. ADD ROOT ENDPOINT ---
// Endpoint to show the bot status (optimized - no message collection)
app.get('/', async (req, res) => {
  try {
    console.log('Root endpoint: Getting basic bot status...');
    
    // Get basic chat count without fetching all chat data
    const chatsSnapshot = await db.collection('chats').limit(1).get();
    const hasChats = !chatsSnapshot.empty;
    
    // Get a simple count of total messages using collection group query (more efficient)
    let totalMessageCount = 0;
    try {
      const messagesSnapshot = await db.collectionGroup('messages').limit(100).get();
      totalMessageCount = messagesSnapshot.size;
    } catch (countError) {
      console.log('Could not get message count:', countError.message);
    }
    
    // Get basic stats without heavy data collection
    const stats = {
      hasChats: hasChats,
      estimatedMessageCount: totalMessageCount >= 100 ? `${totalMessageCount}+` : totalMessageCount,
      lastChecked: new Date().toISOString()
    };

    res.json({
      message: 'LINE Summary Bot is running!',
      status: 'active',
      webhook: '/webhook',
      features: [
        'Message storage (no echo)',
        'AI-powered conversation summarization with /sumGroup and /sumdirect commands',
        'Help system with /help command',
        'Firebase data storage',
        'Rate-limited Gemini API integration'
      ],
      stats: stats,
      endpoints: {
        webhook: '/webhook',
        code: '/code',
        codeUpdate: '/codeupdate',
        messages: '/messages?limit=20'
      },
      note: 'Root endpoint optimized for performance. Use /help for available commands, /sumGroup for group chat summaries, /sumdirect for direct message analysis.'
    });
  } catch (error) {
    console.error('Error in root endpoint:', error);
    res.json({
      message: 'LINE Summary Bot is running!',
      status: 'active',
      webhook: '/webhook',
      error: 'Failed to get basic status',
      errorDetails: error.message
    });
  }
});

// --- 3.5. ADD MESSAGES ENDPOINT ---
// Optional endpoint to get recent messages (when specifically requested)
app.get('/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const maxLimit = 50; // Cap at 50 messages max
    
    if (limit > maxLimit) {
      return res.status(400).json({
        error: `Limit cannot exceed ${maxLimit}`,
        maxAllowed: maxLimit
      });
    }
    
    console.log(`Messages endpoint: Fetching up to ${limit} recent messages...`);
    
    // Get a few recent messages from the first available chat (simpler approach)
    const chatsSnapshot = await db.collection('chats').limit(3).get();
    const messages = [];
    
    for (const chatDoc of chatsSnapshot.docs) {
      const messagesSnapshot = await db.collection('chats')
        .doc(chatDoc.id)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(Math.ceil(limit / chatsSnapshot.size))
        .get();
      
      messagesSnapshot.docs.forEach(doc => {
        const data = doc.data();
        messages.push({
          id: doc.id,
          text: data.text,
          displayName: data.displayName,
          groupName: data.groupName,
          chatsType: data.chatsType,
          timestamp: data.timestamp?.toDate?.() || null,
          userId: data.userId,
          chatId: data.chatsId
        });
      });
      
      if (messages.length >= limit) break;
    }
    
    // Sort all messages by timestamp and take the requested limit
    const sortedMessages = messages
      .sort((a, b) => {
        const timeA = a.timestamp || new Date(0);
        const timeB = b.timestamp || new Date(0);
        return timeB - timeA;
      })
      .slice(0, limit);
    
    res.json({
      message: 'Recent messages retrieved',
      totalMessages: sortedMessages.length,
      requestedLimit: limit,
      messages: sortedMessages
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({
      error: 'Failed to fetch messages',
      details: error.message
    });
  }
});

// --- 3. CREATE THE WEBHOOK ---
// This is the endpoint that LINE will send message data to
app.post('/webhook', (req, res) => {
  if (!config || !client) {
    console.error('LINE Bot configuration not initialized. Please check environment variables.');
    return res.status(500).json({ error: 'Bot configuration not initialized' });
  }
  
  line.middleware(config)(req, res, () => {
    Promise
      .all(req.body.events.map(handleEvent))
      .then((result) => res.json(result))
      .catch((err) => {
        console.error(err);
        res.status(500).end();
      });
  });
});

// --- 3. DEFINE THE EVENT HANDLER ---
// This function handles the incoming messages
async function handleEvent(event) {
  // We only want to handle text messages
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  try {
    

    // Check if message is a command that starts with "/"
    if (event.message.text.startsWith('/')) {
      // Check for specific commands first
      if (event.message.text.toLowerCase() === '/updatecode') {
        try {
          console.log('Processing /updatecode command...');
          
          // Fetch fresh Google Sheets data
          const updatedData = await fetchGoogleSheetsData();
          console.log(`Code data updated successfully. Found ${updatedData.length} entries.`);
          
          const reply = { 
            type: 'text', 
            text: `✅ Code data updated successfully!\n\n📊 Found ${updatedData.length} code entries\n🔄 Cache refreshed at ${new Date().toLocaleString()}` 
          };
          return client.replyMessage(event.replyToken, reply);
          
        } catch (updateError) {
          console.error('Error updating code data:', updateError);
          
          let errorMessage = '❌ Sorry, I encountered an error while updating the code data.';
          
          // Provide more specific error messages
          if (updateError.message && updateError.message.includes('blocked')) {
            errorMessage = '🚫 Google Sheets API is currently blocked. Using cached data instead.';
          } else if (updateError.message && updateError.message.includes('quota')) {
            errorMessage = '📊 API quota exceeded. Please try again later.';
          } else if (updateError.message && updateError.message.includes('403')) {
            errorMessage = '🔐 API access denied. Please check API key permissions.';
          }
          
          const reply = { 
            type: 'text', 
            text: errorMessage 
          };
          return client.replyMessage(event.replyToken, reply);
        }
      } else if (event.message.text.toLowerCase() === '/help' || event.message.text.toLowerCase() === '/?') {
        // Handle /help command
        const helpText = `🤖 **LINE Summary Bot**

AI-powered bot that summarizes group chats and matches codes to links.

**Commands:**
• /sumgroup - Generate group chat summaries
• /sumdirect - Analyze direct messages with code matching and response categorization
• /updatecode - Refresh code database from Google Sheets
• /status - Show system uptime and user statistics
• /help or /? - Show this help message

Send any code to get its corresponding link!`;

        const reply = { type: 'text', text: helpText };
        return client.replyMessage(event.replyToken, reply);
      } else if (event.message.text.toLowerCase() === '/status') {
        // Handle /status command
        try {
          console.log('Processing /status command...');
          
          // Get system uptime
          const uptime = process.uptime();
          const uptimeHours = Math.floor(uptime / 3600);
          const uptimeMinutes = Math.floor((uptime % 3600) / 60);
          const uptimeSeconds = Math.floor(uptime % 60);
          
          // Get follower statistics from LINE API
          let followerStats = {
            followers: 0,
            targetedReaches: 0,
            blocks: 0
          };
          let followerError = null;
          
          try {
            console.log('Fetching follower count from LINE API...');
            
            // Get yesterday's date in YYYYMMDD format for daily insight data
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateString = yesterday.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD format
            
            console.log(`Fetching follower count for date: ${dateString}`);
            const followerResponse = await client.getNumberOfFollowers(dateString);
            console.log('Follower response:', followerResponse);
            
            // Handle the response format from getNumberOfFollowers
            if (followerResponse.status === 'ready' && followerResponse.followers !== undefined) {
              followerStats.followers = followerResponse.followers;
              followerStats.targetedReaches = followerResponse.targetedReaches || 0;
              followerStats.blocks = followerResponse.blocks || 0;
              console.log(`Follower stats for ${dateString}:`, followerStats);
            } else {
              console.log(`Unexpected response status: ${followerResponse.status}`);
              followerError = `API returned status: ${followerResponse.status}`;
            }
          } catch (apiError) {
            console.error('Error fetching follower count from LINE API:', apiError);
            followerError = 'Failed to fetch follower data';
          }
          
          // Format status message
          let statusText = `📊 **System Status**

⏰ **Uptime:** ${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`;

          // Add follower statistics (daily insight data)
          if (followerError) {
            statusText += `\n👥 **Followers:** ❌ ${followerError}`;
          } else {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateString = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
            statusText += `\n👥 **Followers (${dateString}):**`;
            statusText += `\n• Followers: ${followerStats.followers}`;
            statusText += `\n• Targeted Reaches: ${followerStats.targetedReaches}`;
            statusText += `\n• Blocks: ${followerStats.blocks}`;
          }
          
          statusText += `\n\n🔄 **Last Updated:** ${new Date().toLocaleString()}`;
          
          const reply = { type: 'text', text: statusText };
          return client.replyMessage(event.replyToken, reply);
          
        } catch (statusError) {
          console.error('Error processing /status command:', statusError);
          const reply = { type: 'text', text: '❌ Error retrieving system status. Please try again later.' };
          return client.replyMessage(event.replyToken, reply);
        }
      } else if (event.message.text.toLowerCase() === '/sumgroup') {
        try {
          console.log('Processing /sumGroup command...');
          
          // Get the last summary timestamp to filter messages BEFORE saving current command
          const lastSummaryTimestamp = await getLastSummaryTimestamp();
          console.log('Last summary timestamp:', lastSummaryTimestamp ? lastSummaryTimestamp.toDate().toISOString() : 'None found');
          
          // Store the /sumGroup command in database
          try {
            const commandData = {
              commandID: admin.firestore().collection('commands').doc().id, // Generate unique ID
              displayName: 'Unknown User', // Will be updated below
              commandText: '/sumgroup',
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              userId: event.source.userId,
              chatsId: event.source.groupId || event.source.userId,
              chatsType: event.source.groupId ? 'group' : 'user'
            };
            
            // Get user display name
            if (event.source.groupId) {
              const profile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
              commandData.displayName = profile.displayName;
            } else {
              const profile = await client.getProfile(event.source.userId);
              commandData.displayName = profile.displayName;
            }
            
            await db.collection('commands').add(commandData);
            console.log(`Command saved: /sumGroup from ${commandData.displayName}`);
          } catch (commandError) {
            console.error('Error saving /sumGroup command:', commandError);
          }
          
          // Try to get only group chats that the user has participated in
          console.log('Querying group chats collection...');
          const allChatsSnapshot = await db.collection('chats')
            .where('chatsType', '==', 'group')
            .get();
          console.log(`Found ${allChatsSnapshot.size} group chats`);
          
          // Check if no group chats found
          if (allChatsSnapshot.empty) {
            // Try alternative approach - check if there are any messages at all
            console.log('No chats found, trying alternative query...');
            const messagesSnapshot = await db.collectionGroup('messages').limit(5).get();
            console.log(`Found ${messagesSnapshot.size} messages in collection group`);
            
            if (messagesSnapshot.empty) {
              const reply = { type: 'text', text: 'No group chat messages found in database. Try sending some messages to group chats first!' };
              return client.replyMessage(event.replyToken, reply);
            } else {
              // Group messages by chatId, filtering for group chats only
              const chatGroups = {};
              messagesSnapshot.docs.forEach(doc => {
                const data = doc.data();
                const chatId = data.chatsId;
                
                // Only process group chats
                if (data.chatsType === 'group') {
                  if (!chatGroups[chatId]) {
                    chatGroups[chatId] = [];
                  }
                  chatGroups[chatId].push(data);
                }
              });
              
              console.log(`Found messages in ${Object.keys(chatGroups).length} chats:`, Object.keys(chatGroups));
              
              if (Object.keys(chatGroups).length === 0) {
                const reply = { type: 'text', text: 'No group chats found for summarization.' };
                return client.replyMessage(event.replyToken, reply);
              }
              
              // Process all chats in batches using the collection group approach
              const batchSize = 15; // Process 15 chats per batch (matches Gemini RPM limit)
              const chatEntries = Object.entries(chatGroups);
              console.log(`Processing ${chatEntries.length} chats from collection group in batches of ${batchSize}`);
              
              // Convert chat entries to a format compatible with batch processing
              const chatDocs = chatEntries.map(([chatId, messages]) => ({
                id: chatId,
                data: () => ({ chatsId: chatId })
              }));
              
              // Create a custom batch processing function for collection group data
              await processCollectionGroupChatsInBatches(client, event, chatEntries, lastSummaryTimestamp, batchSize);
            }
          }

          // Process all chats in batches to ensure all chats are summarized
          const batchSize = 15; // Process 15 chats per batch (matches Gemini RPM limit)
          console.log(`Processing ${allChatsSnapshot.docs.length} chats in batches of ${batchSize}`);
          
          // Use the new batch processing function
          await processChatsInBatches(client, event, allChatsSnapshot.docs, lastSummaryTimestamp, batchSize);

        } catch (summaryError) {
          console.error('Error generating summary:', summaryError);
          
          let errorMessage = 'Sorry, I encountered an error while generating the summary.';
          
          // Provide more specific error messages
          if (summaryError.message && summaryError.message.includes('Rate limit exceeded')) {
            errorMessage = '⏰ I\'m currently rate limited by the AI service. Please wait a moment and try again in a few minutes.';
          } else if (summaryError.message && summaryError.message.includes('quota')) {
            errorMessage = '📊 I\'ve reached my daily quota limit for AI requests. Please try again tomorrow.';
          } else if (summaryError.message && summaryError.message.includes('429')) {
            errorMessage = '🚦 Too many requests at once. Please wait a moment before trying again.';
          }
          
          const reply = { type: 'text', text: errorMessage };
          return client.replyMessage(event.replyToken, reply);
        }
      } else if (event.message.text.toLowerCase() === '/sumdirect') {
        try {
          console.log('Processing /sumdirect command...');
          
          // Get the last summary timestamp for '/sumdirect' command
          const lastSummaryTimestamp = await getLastSummaryTimestamp('/sumdirect');
          console.log('Last /sumdirect timestamp:', lastSummaryTimestamp ? lastSummaryTimestamp.toDate().toISOString() : 'None found');
          
          // Query direct messages (reduced limit to avoid API overload)
          const directMessages = await queryDirectMessages(lastSummaryTimestamp, 50);
          
          if (directMessages.length === 0) {
            const reply = { type: 'text', text: 'No direct messages found to analyze.' };
            return client.replyMessage(event.replyToken, reply);
          }
          
          // Generate AI summary
          const summary = await generateDirectMessageSummary(directMessages);
          
          // Split summary into multiple messages if too long
          const summaryMessages = splitIntoMessages(summary);
          const targetId = event.source.groupId || event.source.userId;
          await sendLineMessages(client, event.replyToken, targetId, summaryMessages);
          
          // Save the /sumdirect command to database after successful reply
          try {
            const commandData = {
              commandID: admin.firestore().collection('commands').doc().id,
              displayName: 'Unknown User',
              commandText: '/sumdirect',
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              userId: event.source.userId,
              chatsId: event.source.groupId || event.source.userId,
              chatsType: event.source.groupId ? 'group' : 'user'
            };
            
            // Get user display name
            if (event.source.groupId) {
              const profile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
              commandData.displayName = profile.displayName;
            } else {
              const profile = await client.getProfile(event.source.userId);
              commandData.displayName = profile.displayName;
            }
            
            await db.collection('commands').add(commandData);
            console.log(`Command saved: /sumdirect from ${commandData.displayName}`);
          } catch (commandError) {
            console.error('Error saving /sumdirect command:', commandError);
          }
          
        } catch (sumdirectError) {
          console.error('Error processing /sumdirect command:', sumdirectError);
          
          let errorMessage = 'Sorry, I encountered an error while processing the /sumdirect command.';
          
          // Provide more specific error messages
          if (sumdirectError.message && sumdirectError.message.includes('Rate limit exceeded')) {
            errorMessage = '⏰ I\'m currently rate limited by the AI service. Please wait a moment and try again in a few minutes.';
          } else if (sumdirectError.message && sumdirectError.message.includes('quota')) {
            errorMessage = '📊 I\'ve reached my daily quota limit for AI requests. Please try again tomorrow.';
          } else if (sumdirectError.message && sumdirectError.message.includes('429')) {
            errorMessage = '🚦 Too many requests at once. Please wait a moment before trying again.';
          } else if (sumdirectError.message && (sumdirectError.message.includes('503') || sumdirectError.message.includes('overloaded'))) {
            errorMessage = '🔄 The AI service is currently overloaded. Please try again in a few minutes.';
          }
          
          const reply = { type: 'text', text: errorMessage };
          return client.replyMessage(event.replyToken, reply);
        }
      } else {
        // Unknown command - respond with "bad command"
        console.log(`Unknown command received: ${event.message.text}`);
        const reply = { type: 'text', text: 'bad command' };
        return client.replyMessage(event.replyToken, reply);
      }
    } else {
      // Only save non-command messages to database and check for code matches
      const messageDocRef = await saveMessageToDatabase(event, client);
      
      // Check if message text matches any code from cached Google Sheets data
      try {
        const trimmedMessage = event.message.text.trim();
        console.log(`Checking if "${trimmedMessage}" matches any code from cached Google Sheets data...`);
        
        // Find case-insensitive match with trimmed whitespace for the message text in the "code" column
        const matchingRow = cachedSheetsData.find(row => 
          row.code && row.code.trim().toLowerCase() === trimmedMessage.toLowerCase()
        );
        
        if (matchingRow) {
          console.log(`Found matching code: ${matchingRow.code} -> ${matchingRow.link}`);
          
          // Update the message with responseType: "code replied"
          if (messageDocRef) {
            try {
              await messageDocRef.update({
                responseType: 'code replied'
              });
              console.log(`Updated message with responseType: code replied`);
            } catch (updateError) {
              console.error('Error updating message responseType:', updateError);
            }
          }
          
          const reply = { type: 'text', text: matchingRow.link };
          return client.replyMessage(event.replyToken, reply);
        } else {
          console.log(`No matching code found for: "${trimmedMessage}"`);
        }
      } catch (codeCheckError) {
        console.error('Error checking code from cached Google Sheets data:', codeCheckError);
        // Continue with regular message processing if code check fails
      }

      // Message has already been saved to database with responseType: null
      // No additional processing needed for regular messages
      return Promise.resolve(null);
    }
  } catch (error) {
    console.error('Error handling event:', error);
    // Still try to send the echo reply even if Firestore write fails
    const echo = { type: 'text', text: event.message.text };
    return client.replyMessage(event.replyToken, echo);
  }
}

// --- 4. EXPORT FIREBASE FUNCTIONS ---
// Export the Express app as Firebase Functions

// Initialize Google Sheets data on function cold start
let sheetsDataInitialized = false;
async function initializeSheetsData() {
  if (!sheetsDataInitialized) {
    try {
      console.log('Initializing Google Sheets data...');
      const data = await fetchGoogleSheetsData();
      console.log(`Google Sheets data initialized successfully with ${data.length} entries`);
      sheetsDataInitialized = true;
    } catch (error) {
      console.log('Google Sheets initialization failed, will retry on next request');
      // Don't mark as initialized so it will retry on next request
    }
  }
}

const { onRequest } = require('firebase-functions/v2/https');

// Export all routes as Firebase Functions v2
exports.lineSummaryBot = onRequest({ timeoutSeconds: 300, maxInstances: 1 }, async (req, res) => {
  // Initialize sheets data on first request
  await initializeSheetsData();
  
  // Handle CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  // Route the request to the Express app
  app(req, res);
});