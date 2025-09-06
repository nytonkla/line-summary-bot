// index.js
// console.log('Hello, world!');
// Import the necessary libraries
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

// Initialize Google AI (Gemini)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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

// --- 2. ADD ROOT ENDPOINT ---
// Simple endpoint to show the bot is running
app.get('/', (req, res) => {
  res.json({
    message: 'LINE Summary Bot is running!',
    status: 'active',
    webhook: '/webhook',
    features: [
      'Message echo',
      'AI-powered conversation summarization with /summarize command',
      'Firebase data storage'
    ]
  });
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
    if (event.message.text.toLowerCase() === '/summarize') {
      try {
        console.log('Processing /summarize command...');
        
        // Try to get all chats (groups and users) that the user has participated in
        console.log('Querying chats collection...');
        const allChatsSnapshot = await db.collection('chats').get();
        console.log(`Found ${allChatsSnapshot.size} chats`);
        
        // Debug: List all chat IDs
        allChatsSnapshot.docs.forEach(doc => {
          console.log(`Chat ID: ${doc.id}`);
        });
        
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
            
            // Process the grouped messages
            const summaries = [];
            for (const [chatId, messages] of Object.entries(chatGroups)) {
              console.log(`Processing chat ${chatId} with ${messages.length} messages`);
              
              // Sort messages by timestamp and take last 20
              const sortedMessages = messages
                .sort((a, b) => {
                  const timeA = a.timestamp?.toDate?.() || new Date(0);
                  const timeB = b.timestamp?.toDate?.() || new Date(0);
                  return timeA - timeB;
                })
                .slice(-20)
                .filter(msg => msg.text && msg.text.toLowerCase() !== '/summarize');
              
              console.log(`After filtering: ${sortedMessages.length} messages remain`);
              if (sortedMessages.length === 0) {
                console.log('No messages after filtering, skipping this chat');
                continue;
              }
              
              const firstMessage = sortedMessages[0];
              const chatName = firstMessage.chatsType === 'group' 
                ? (firstMessage.groupName || 'Unknown Group')
                : (firstMessage.displayName || 'Direct Chat');
              
              const conversationText = sortedMessages
                .map(msg => `${msg.displayName || 'User'}: ${msg.text}`)
                .join('\n');
              
              const summaryPrompt = `Please provide a concise summary of the following conversation from "${chatName}":\n\n${conversationText}\n\nSummary:`;
              console.log(`Generating summary for ${chatName}...`);
              const result = await model.generateContent(summaryPrompt);
              const response = await result.response;
              const summary = response.text();
              console.log(`Summary generated for ${chatName}: ${summary.substring(0, 100)}...`);
              
              summaries.push(`📝 **${chatName}**\n${summary}\n`);
            }
            
            console.log(`Generated ${summaries.length} summaries`);
            if (summaries.length === 0) {
              console.log('No summaries generated, sending error message');
              const reply = { type: 'text', text: 'No messages found to summarize. Try sending some messages first!' };
              return client.replyMessage(event.replyToken, reply);
            }
            
            const combinedSummary = summaries.join('\n---\n\n');
            console.log('Sending combined summary to user');
            const reply = { type: 'text', text: `📋 **Conversation Summaries**\n\n${combinedSummary}` };
            return client.replyMessage(event.replyToken, reply);
          }
        }

        const summaries = [];
        
        // Process each chat
        for (const chatDoc of allChatsSnapshot.docs) {
          const chatId = chatDoc.id;
          console.log(`Processing chat: ${chatId}`);
          
          // Get last 20 messages from this chat
          const messagesSnapshot = await db.collection('chats')
            .doc(chatId)
            .collection('messages')
            .orderBy('timestamp', 'desc')
            .limit(20)
            .get();

          console.log(`Found ${messagesSnapshot.size} messages in chat ${chatId}`);
          if (messagesSnapshot.empty) continue;

          // Convert to array and reverse to get chronological order
          const messages = messagesSnapshot.docs
            .map(doc => doc.data())
            .reverse()
            .filter(msg => msg.text && msg.text.toLowerCase() !== '/summarize'); // Exclude the command itself

          console.log(`After filtering, ${messages.length} messages remain in chat ${chatId}`);
          if (messages.length === 0) continue;

          // Get chat info (group name or user info)
          const firstMessage = messages[0];
          const chatName = firstMessage.chatsType === 'group' 
            ? (firstMessage.groupName || 'Unknown Group')
            : (firstMessage.displayName || 'Direct Chat');

          console.log(`Generating summary for chat: ${chatName}`);

          // Create conversation text for this chat
          const conversationText = messages
            .map(msg => `${msg.displayName || 'User'}: ${msg.text}`)
            .join('\n');

          // Generate summary for this chat
          const summaryPrompt = `Please provide a concise summary of the following conversation from "${chatName}":\n\n${conversationText}\n\nSummary:`;
          const result = await model.generateContent(summaryPrompt);
          const response = await result.response;
          const summary = response.text();

          summaries.push(`📝 **${chatName}**\n${summary}\n`);
        }

        console.log(`Generated ${summaries.length} summaries`);
        if (summaries.length === 0) {
          const reply = { type: 'text', text: 'No messages found to summarize. Try sending some messages first!' };
          return client.replyMessage(event.replyToken, reply);
        }

        // Combine all summaries
        const combinedSummary = summaries.join('\n---\n\n');
        console.log('Generated summaries:', combinedSummary);

        const reply = { type: 'text', text: `📋 **Conversation Summaries**\n\n${combinedSummary}` };
        return client.replyMessage(event.replyToken, reply);

      } catch (summaryError) {
        console.error('Error generating summary:', summaryError);
        const reply = { type: 'text', text: 'Sorry, I encountered an error while generating the summary.' };
        return client.replyMessage(event.replyToken, reply);
      }
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
    await db.collection('chats')
      .doc(chatsId)
      .collection('messages')
      .add(messageData);
    
    console.log(`Message saved to Firestore for ${chatsType} ${chatsId} from ${displayName}:`, messageData);

    // Regular echo for non-command messages
    const echo = { type: 'text', text: event.message.text };
    return client.replyMessage(event.replyToken, echo);
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
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});