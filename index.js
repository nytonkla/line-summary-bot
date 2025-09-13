// index.js
// console.log('Hello, world!');
// Import the necessary libraries
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

// Initialize Firebase Admin SDK
console.log('Initializing Firebase...');
const serviceAccount = require('./serviceAccountKey.json');
console.log('Service account loaded successfully');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
console.log('Firebase app initialized');

const db = admin.firestore();
console.log('Firestore database connection established');

// Initialize Google AI (Gemini)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Global variable to store Google Sheets data
let cachedSheetsData = [];

// Function to split long text into multiple messages (LINE has 5000 char limit per message)
function splitIntoMessages(text, maxLength = 4000) {
  const messages = [];
  const lines = text.split('\n');
  let currentMessage = '';
  
  for (const line of lines) {
    // If adding this line would exceed the limit, start a new message
    if (currentMessage.length + line.length + 1 > maxLength && currentMessage.length > 0) {
      messages.push(currentMessage.trim());
      currentMessage = line;
    } else {
      currentMessage += (currentMessage.length > 0 ? '\n' : '') + line;
    }
  }
  
  // Add the last message if it has content
  if (currentMessage.trim().length > 0) {
    messages.push(currentMessage.trim());
  }
  
  return messages;
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
async function generateContentWithRetry(prompt, maxRetries = 3) {
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
          // Exponential backoff: wait 2^attempt seconds
          const waitTime = Math.pow(2, attempt) * 1000;
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
        .filter(msg => msg.text && msg.text.toLowerCase() !== '/summarize');

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
      const chatName = chatType === 'group' 
        ? (firstMessage.groupName || 'Unknown Group')
        : (firstMessage.displayName || 'Direct Chat');

      console.log(`Generating summary for ${chatType}: ${chatName}`);

      // Create conversation text for this chat
      const conversationText = messages
        .map(msg => `${msg.displayName || 'User'}: ${msg.text}`)
        .join('\n');

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
      const batchTitle = totalBatches > 1 ? ` (Batch ${batchNumber}/${totalBatches})` : '';
      const combinedSummary = summaries.join('\n----\n');
      
      // Split the summary into multiple messages if it's too long
      const summaryMessages = splitIntoMessages(`📋 **Conversation Summaries${batchTitle}**\n\n${combinedSummary}`);
      
      // Create an array of message objects
      const messages = summaryMessages.map(text => ({
        type: 'text',
        text: text
      }));
      
      // Send the batch - use reply for first batch, push for subsequent batches
      if (batchNumber === 1) {
        await client.replyMessage(event.replyToken, messages);
      } else {
        // For subsequent batches, use push message to the user/group
        const targetId = event.source.groupId || event.source.userId;
        await client.pushMessage(targetId, messages);
      }
      
      // Add a 1-minute delay between batches to respect RPM limits
      if (i + batchSize < totalChats) {
        console.log(`Waiting 1 minute (60 seconds) before processing next batch to respect RPM limits...`);
        await new Promise(resolve => setTimeout(resolve, 60000)); // 60 seconds = 1 minute
      }
    }
  }
  
  console.log(`Completed processing all ${totalChats} chats`);
}

// Function to process collection group chats in batches
async function processCollectionGroupChatsInBatches(client, event, chatEntries, lastSummaryTimestamp, batchSize = 15) {
  const totalChats = chatEntries.length;
  console.log(`Processing ${totalChats} collection group chats in batches of ${batchSize}`);
  
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
      let filteredMessages = messages.filter(msg => msg.text && msg.text.toLowerCase() !== '/summarize');
      
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
      const chatName = chatType === 'group' 
        ? (firstMessage.groupName || 'Unknown Group')
        : (firstMessage.displayName || 'Direct Chat');
      
      console.log(`Generating summary for ${chatType}: ${chatName}...`);
      
      const conversationText = filteredMessages
        .map(msg => `${msg.displayName || 'User'}: ${msg.text}`)
        .join('\n');
      
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
      const batchTitle = totalBatches > 1 ? ` (Batch ${batchNumber}/${totalBatches})` : '';
      const combinedSummary = summaries.join('----------\n');
      
      // Split the summary into multiple messages if it's too long
      const summaryMessages = splitIntoMessages(`📋 **Conversation Summaries${batchTitle}**\n\n${combinedSummary}`);
      
      // Create an array of message objects
      const messages = summaryMessages.map(text => ({
        type: 'text',
        text: text
      }));
      
      // Send the batch - use reply for first batch, push for subsequent batches
      if (batchNumber === 1) {
        await client.replyMessage(event.replyToken, messages);
      } else {
        // For subsequent batches, use push message to the user/group
        const targetId = event.source.groupId || event.source.userId;
        await client.pushMessage(targetId, messages);
      }
      
      // Add a 1-minute delay between batches to respect RPM limits
      if (i + batchSize < totalChats) {
        console.log(`Waiting 1 minute (60 seconds) before processing next batch to respect RPM limits...`);
        await new Promise(resolve => setTimeout(resolve, 60000)); // 60 seconds = 1 minute
      }
    }
  }
  
  console.log(`Completed processing all ${totalChats} collection group chats`);
}

// Function to get the last summary timestamp from commands collection
async function getLastSummaryTimestamp() {
  try {
    const commandsSnapshot = await db.collection('commands')
      .where('commandText', '==', '/summarize')
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
    const sheets = google.sheets({ version: 'v4', auth: process.env.GOOGLE_API_KEY });
    
    // Fetch data from the sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'A:C', // Get columns A, B, C (status, code, link)
    });
    
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
    return cachedSheetsData; // Return cached data if fetch fails
  }
}

// --- 1. SET UP YOUR CONFIGURATION ---
// Get your Channel Access Token and Channel Secret from the LINE Developers Console
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// Create a new LINE SDK client
const client = new line.Client(config);

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
        'AI-powered conversation summarization with /summarize command',
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
      note: 'Root endpoint optimized for performance. Use /summarize command for conversation summaries.'
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
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
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
    // Check if the message is a command FIRST (before saving to database)
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
        const reply = { 
          type: 'text', 
          text: '❌ Sorry, I encountered an error while updating the code data. Please try again later.' 
        };
        return client.replyMessage(event.replyToken, reply);
      }
    }
    
    if (event.message.text.toLowerCase() === '/summarize') {
      try {
        console.log('Processing /summarize command...');
        
        // Get the last summary timestamp to filter messages BEFORE saving current command
        const lastSummaryTimestamp = await getLastSummaryTimestamp();
        console.log('Last summary timestamp:', lastSummaryTimestamp ? lastSummaryTimestamp.toDate().toISOString() : 'None found');
        
        // Store the /summarize command in database
        try {
          const commandData = {
            commandID: admin.firestore().collection('commands').doc().id, // Generate unique ID
            displayName: 'Unknown User', // Will be updated below
            commandText: '/summarize',
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
          console.log(`Command saved: /summarize from ${commandData.displayName}`);
        } catch (commandError) {
          console.error('Error saving /summarize command:', commandError);
        }
        
        // Try to get all chats (groups and users) that the user has participated in
        //console.log('Querying chats collection...');
        const allChatsSnapshot = await db.collection('chats').get();
        console.log(`Found ${allChatsSnapshot.size} chats`);
        
        // Debug: List all chat IDs
        // allChatsSnapshot.docs.forEach(doc => {
        //   console.log(`Chat ID: ${doc.id}`);
        // });
        if (allChatsSnapshot.empty) {
          // Try alternative approach - check if there are any messages at all
          console.log('No chats found, trying alternative query...');
          const messagesSnapshot = await db.collectionGroup('messages').limit(5).get();
          console.log(`Found ${messagesSnapshot.size} messages in collection group`);
          
          if (messagesSnapshot.empty) {
            const reply = { type: 'text', text: 'No messages found in database. Try sending some messages first!' };
            return client.replyMessage(event.replyToken, reply);
          } else {
            // Group messages by chatId
            const chatGroups = {};
            messagesSnapshot.docs.forEach(doc => {
              const data = doc.data();
              const chatId = data.chatsId;
              if (!chatGroups[chatId]) {
                chatGroups[chatId] = [];
              }
              chatGroups[chatId].push(data);
            });
            
            console.log(`Found messages in ${Object.keys(chatGroups).length} chats:`, Object.keys(chatGroups));
            
            if (Object.keys(chatGroups).length === 0) {
              const reply = { type: 'text', text: 'No valid chat groups found.' };
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
    }

    // Check if message text matches any code from cached Google Sheets data
    try {
      console.log(`Checking if "${event.message.text}" matches any code from cached Google Sheets data...`);
      
      // Find exact match for the message text in the "code" column
      const matchingRow = cachedSheetsData.find(row => row.code === event.message.text);
      
      if (matchingRow) {
        console.log(`Found matching code: ${matchingRow.code} -> ${matchingRow.link}`);
        const reply = { type: 'text', text: matchingRow.link };
        return client.replyMessage(event.replyToken, reply);
      } else {
        console.log(`No matching code found for: "${event.message.text}"`);
      }
    } catch (codeCheckError) {
      console.error('Error checking code from cached Google Sheets data:', codeCheckError);
      // Continue with regular message processing if code check fails
    }

    // Regular message processing (for non-command messages)
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
      chatsType: chatsType
    };

    // Add to Firestore collection, grouped by chats
    console.log(`Attempting to save message to Firestore for ${chatsType} ${chatsId} from ${displayName}`);
    try {
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
    } catch (firestoreError) {
      console.error('Firestore save error:', firestoreError);
      throw firestoreError;
    }
    
    console.log(`Message saved to Firestore for ${chatsType} from ${displayName}:`, messageData.text);

    // Don't echo messages anymore, just save to database
    return Promise.resolve(null);
  } catch (error) {
    console.error('Error handling event:', error);
    // Still try to send the echo reply even if Firestore write fails
    const echo = { type: 'text', text: event.message.text };
    return client.replyMessage(event.replyToken, echo);
  }
}

// --- 4. START THE SERVER ---
// Tell the server to listen for requests on a specific port
// Use Render's PORT environment variable, fallback to 3000 for local development
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`Listening on port ${port}`);
  
  // Initialize Google Sheets data on startup
  try {
    console.log('Initializing Google Sheets data on startup...');
    await fetchGoogleSheetsData();
    console.log('Google Sheets data initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Google Sheets data on startup:', error);
    console.log('Bot will continue running with empty cache. Use /codeupdate to manually update.');
  }
});