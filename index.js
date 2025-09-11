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

// Function to get the last summary timestamp from commands collection
async function getLastSummaryTimestamp() {
  try {
    console.log('Querying commands collection for last /summarize command...');
    const commandsSnapshot = await db.collection('commands')
      .where('commandText', '==', '/summarize')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    
    console.log(`Found ${commandsSnapshot.size} /summarize commands in database`);
    
    if (!commandsSnapshot.empty) {
      const lastCommand = commandsSnapshot.docs[0].data();
      console.log('Last /summarize command data:', {
        commandID: lastCommand.commandID,
        displayName: lastCommand.displayName,
        timestamp: lastCommand.timestamp,
        timestampFormatted: lastCommand.timestamp?.toDate?.()?.toISOString(),
        userId: lastCommand.userId,
        chatsId: lastCommand.chatsId
      });
      return lastCommand.timestamp;
    }
    console.log('No previous /summarize commands found');
    return null;
  } catch (error) {
    console.error('Error getting last summary timestamp:', error);
    return null;
  }
}

// Function to fetch data from Google Sheets
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
    
    return data;
  } catch (error) {
    console.error('Error fetching Google Sheets data:', error);
    return [];
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

// --- 2. ADD GOOGLE SHEETS ENDPOINT ---
// Endpoint to fetch and display Google Sheets data
app.get('/sheets', async (req, res) => {
  try {
    const sheetsData = await fetchGoogleSheetsData();
    res.json({
      message: 'Google Sheets Data',
      totalRows: sheetsData.length,
      data: sheetsData
    });
  } catch (error) {
    console.error('Error in /sheets endpoint:', error);
    res.status(500).json({
      error: 'Failed to fetch Google Sheets data',
      details: error.message
    });
  }
});

// --- 3. ADD ROOT ENDPOINT ---
// Endpoint to show the bot status and last 20 messages
app.get('/', async (req, res) => {
  try {
    // console.log('Root endpoint: Fetching messages from database...');
    
    // Get all chats first
    const chatsSnapshot = await db.collection('chats').get();
    console.log(`Root endpoint: Found ${chatsSnapshot.size} chats`);
    
    if (chatsSnapshot.empty) {
      console.log('Root endpoint: No chats found');
      res.json({
        message: 'LINE Summary Bot is running!',
        status: 'active',
        webhook: '/webhook',
        features: [
          'Message storage (no echo)',
          'AI-powered conversation summarization with /summarize command',
          'Firebase data storage'
        ],
        lastMessages: [],
        totalMessages: 0,
        note: 'No chats found in database yet'
      });
      return;
    }

    // Collect messages from all chats
    const allMessages = [];
    
    for (const chatDoc of chatsSnapshot.docs) {
      const chatId = chatDoc.id;
      // console.log(`Root endpoint: Checking chat ${chatId}`);
      
      const messagesSnapshot = await db.collection('chats')
        .doc(chatId)
        .collection('messages')
        .limit(10) // Get up to 10 messages per chat
        .get();
      
      console.log(`Root endpoint: Found ${messagesSnapshot.size} messages in chat ${chatId}`);
      
      messagesSnapshot.docs.forEach(doc => {
        const data = doc.data();
        // console.log(`Root endpoint: Message data:`, {
        //   id: doc.id,
        //   text: data.text,
        //   timestamp: data.timestamp,
        //   hasTimestamp: !!data.timestamp
        // });
        
        allMessages.push({
          id: doc.id,
          text: data.text,
          displayName: data.displayName,
          groupName: data.groupName,
          chatsType: data.chatsType,
          timestamp: data.timestamp?.toDate?.() || null,
          userId: data.userId,
          chatId: chatId
        });
      });
    }
    
    console.log(`Root endpoint: Total messages collected: ${allMessages.length}`);

    // Sort by timestamp and take last 20
    const sortedMessages = allMessages
      .sort((a, b) => {
        const timeA = a.timestamp || new Date(0);
        const timeB = b.timestamp || new Date(0);
        return timeB - timeA; // Descending order
      })
      .slice(0, 20);

    res.json({
      message: 'LINE Summary Bot is running!',
      status: 'active',
      webhook: '/webhook',
      features: [
        'Message storage (no echo)',
        'AI-powered conversation summarization with /summarize command',
        'Firebase data storage'
      ],
      lastMessages: sortedMessages,
      totalMessages: sortedMessages.length
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.json({
      message: 'LINE Summary Bot is running!',
      status: 'active',
      webhook: '/webhook',
      error: 'Failed to fetch messages from database',
      errorDetails: error.message
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
    if (event.message.text.toLowerCase() === '/summarize') {
      try {
        console.log('Processing /summarize command...');
        
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
          console.log('Current command timestamp (server timestamp):', new Date().toISOString());
        } catch (commandError) {
          console.error('Error saving /summarize command:', commandError);
        }
        
        // Get the last summary timestamp to filter messages
        const lastSummaryTimestamp = await getLastSummaryTimestamp();
        console.log('Last summary timestamp:', lastSummaryTimestamp);
        if (lastSummaryTimestamp) {
          console.log('Last summary timestamp (formatted):', lastSummaryTimestamp.toDate());
          console.log('Last summary timestamp (ISO string):', lastSummaryTimestamp.toDate().toISOString());
        } else {
          console.log('No previous summary timestamp found - will take last 30 messages');
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
            
            // Process the grouped messages
            const summaries = [];
            for (const [chatId, messages] of Object.entries(chatGroups)) {
              console.log(`Processing chat ${chatId} with ${messages.length} messages`);
              
              // Filter messages based on last summary timestamp
              let filteredMessages = messages.filter(msg => msg.text && msg.text.toLowerCase() !== '/summarize');
              
              if (lastSummaryTimestamp) {
                console.log(`\n=== TIMESTAMP FILTERING DEBUG (alternative path) ===`);
                console.log(`Last summary timestamp: ${lastSummaryTimestamp.toDate().toISOString()}`);
                console.log(`Total messages before filtering: ${filteredMessages.length}`);
                
                // Log first few message timestamps for debugging
                console.log('Sample message timestamps:');
                filteredMessages.slice(0, 5).forEach((msg, index) => {
                  if (msg.timestamp) {
                    console.log(`  Message ${index + 1}: ${msg.timestamp.toDate().toISOString()} (${msg.text?.substring(0, 50)}...)`);
                  } else {
                    console.log(`  Message ${index + 1}: NO TIMESTAMP (${msg.text?.substring(0, 50)}...)`);
                  }
                });
                
                // Filter messages after the last summary timestamp
                const originalCount = filteredMessages.length;
                filteredMessages = filteredMessages.filter(msg => {
                  if (!msg.timestamp) {
                    console.log(`  Filtering out message with no timestamp: ${msg.text?.substring(0, 50)}...`);
                    return false;
                  }
                  const msgTime = msg.timestamp.toDate();
                  const lastSummaryTime = lastSummaryTimestamp.toDate();
                  const isAfter = msgTime > lastSummaryTime;
                  console.log(`  Message ${msg.timestamp.toDate().toISOString()} > ${lastSummaryTimestamp.toDate().toISOString()}? ${isAfter} (${msg.text?.substring(0, 30)}...)`);
                  return isAfter;
                });
                console.log(`After filtering by timestamp: ${filteredMessages.length} messages remain (filtered out ${originalCount - filteredMessages.length} messages)`);
                console.log(`=== END TIMESTAMP FILTERING DEBUG (alternative path) ===\n`);
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
              
              const sortedMessages = filteredMessages;
              
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
              console.log('No summaries generated, sending no updates message');
              const reply = { type: 'text', text: 'No more updates' };
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
          //console.log(`Processing chat: ${chatId}`);
          
          // Get messages from this chat (limit based on whether we have a timestamp filter)
          const limit = lastSummaryTimestamp ? 100 : 30; // Get more messages if filtering by timestamp
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
            .filter(msg => msg.text && msg.text.toLowerCase() !== '/summarize'); // Exclude the command itself

          // Filter messages based on last summary timestamp
          if (lastSummaryTimestamp) {
            console.log(`\n=== TIMESTAMP FILTERING DEBUG for chat ${chatId} ===`);
            console.log(`Last summary timestamp: ${lastSummaryTimestamp.toDate().toISOString()}`);
            console.log(`Total messages before filtering: ${messages.length}`);
            
            // Log first few message timestamps for debugging
            console.log('Sample message timestamps:');
            messages.slice(0, 5).forEach((msg, index) => {
              if (msg.timestamp) {
                console.log(`  Message ${index + 1}: ${msg.timestamp.toDate().toISOString()} (${msg.text?.substring(0, 50)}...)`);
              } else {
                console.log(`  Message ${index + 1}: NO TIMESTAMP (${msg.text?.substring(0, 50)}...)`);
              }
            });
            
            // Filter messages after the last summary timestamp
            const originalCount = messages.length;
            messages = messages.filter(msg => {
              if (!msg.timestamp) {
                console.log(`  Filtering out message with no timestamp: ${msg.text?.substring(0, 50)}...`);
                return false;
              }
              const msgTime = msg.timestamp.toDate();
              const lastSummaryTime = lastSummaryTimestamp.toDate();
              const isAfter = msgTime > lastSummaryTime;
              console.log(`  Message ${msg.timestamp.toDate().toISOString()} > ${lastSummaryTimestamp.toDate().toISOString()}? ${isAfter} (${msg.text?.substring(0, 30)}...)`);
              return isAfter;
            });
            console.log(`After filtering by timestamp: ${messages.length} messages remain in chat ${chatId} (filtered out ${originalCount - messages.length} messages)`);
            console.log(`=== END TIMESTAMP FILTERING DEBUG ===\n`);
          } else {
            // If no previous summary, take last 30 messages
            messages = messages.slice(-30);
            console.log(`No previous summary found, taking last 30 messages: ${messages.length} messages in chat ${chatId}`);
          }

          //console.log(`After filtering, ${messages.length} messages remain in chat ${chatId}`);
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
          const reply = { type: 'text', text: 'No more updates' };
          return client.replyMessage(event.replyToken, reply);
        }

        // Combine all summaries
        const combinedSummary = summaries.join('\n---\n\n');
        //console.log('Generated summaries:', combinedSummary);

        const reply = { type: 'text', text: `📋 **Conversation Summaries**\n\n${combinedSummary}` };
        return client.replyMessage(event.replyToken, reply);

      } catch (summaryError) {
        console.error('Error generating summary:', summaryError);
        const reply = { type: 'text', text: 'Sorry, I encountered an error while generating the summary.' };
        return client.replyMessage(event.replyToken, reply);
      }
    }

    // Check if message text matches any code from Google Sheets
    try {
      console.log(`Checking if "${event.message.text}" matches any code from Google Sheets...`);
      const sheetsData = await fetchGoogleSheetsData();
      
      // Find exact match for the message text in the "code" column
      const matchingRow = sheetsData.find(row => row.code === event.message.text);
      
      if (matchingRow) {
        console.log(`Found matching code: ${matchingRow.code} -> ${matchingRow.link}`);
        const reply = { type: 'text', text: matchingRow.link };
        return client.replyMessage(event.replyToken, reply);
      } else {
        console.log(`No matching code found for: "${event.message.text}"`);
      }
    } catch (codeCheckError) {
      console.error('Error checking code from Google Sheets:', codeCheckError);
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
    
    console.log(`Message saved to Firestore for ${chatsType} from ${displayName}:`, messageData);

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
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});