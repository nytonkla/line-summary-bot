// index.js
// console.log('Hello, world!');
// Import the necessary libraries
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createMcpServer, SSEServerTransport, StreamableHTTPServerTransport } = require('./mcp-server');

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
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });

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
    const { google } = require('googleapis');
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
app.use(cors());

// --- OAUTH 2.0 FOR CLAUDE DYNAMIC CLIENT REGISTRATION (RFC 7591 / RFC 8414) ---
const oauthClients = new Map();
const oauthCodes = new Map();

// 1. Authorization Server Metadata
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: host,
    authorization_endpoint: `${host}/oauth/authorize`,
    token_endpoint: `${host}/oauth/token`,
    registration_endpoint: `${host}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none']
  });
});

// 2. Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  res.json({
    resource: host,
    authorization_servers: [host]
  });
});

// 3. Dynamic Client Registration (RFC 7591)
app.post('/oauth/register', express.json(), (req, res) => {
  const clientId = 'claude_' + Date.now();
  const clientSecret = 'secret_' + Math.random().toString(36).substring(2);
  const clientData = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: req.body.client_name || 'Claude Connector',
    redirect_uris: req.body.redirect_uris || []
  };
  oauthClients.set(clientId, clientData);
  res.status(201).json(clientData);
});

// 4. Authorization Endpoint (Immediate redirect with code and state preserved)
app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query;
  const code = 'code_' + Math.random().toString(36).substring(2, 12);
  oauthCodes.set(code, { client_id, redirect_uri, token: process.env.MCP_ACCESS_TOKEN });

  let redirectTarget = redirect_uri || 'https://claude.ai';
  try {
    const url = new URL(redirectTarget);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    redirectTarget = url.toString();
  } catch (e) {
    redirectTarget += (redirectTarget.includes('?') ? '&' : '?') + `code=${code}${state ? `&state=${state}` : ''}`;
  }

  console.log('OAuth authorize redirecting to:', redirectTarget);
  res.redirect(redirectTarget);
});

// 5. Token Exchange Endpoint
app.post('/oauth/token', express.json(), express.urlencoded({ extended: true }), (req, res) => {
  res.json({
    access_token: process.env.MCP_ACCESS_TOKEN,
    token_type: 'bearer',
    expires_in: 31536000
  });
});

// Universal MCP Authentication Middleware
const mcpAuthMiddleware = (req, res, next) => {
  const expectedToken = process.env.MCP_ACCESS_TOKEN;
  if (!expectedToken) {
    console.warn('MCP_ACCESS_TOKEN is not configured in environment variable.');
    return res.status(500).json({ error: 'MCP server configuration error: MCP_ACCESS_TOKEN missing.' });
  }

  // 1. Authorization header (Bearer <token> or raw token)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const tokenVal = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : authHeader.trim();
    if (tokenVal === expectedToken) return next();
  }

  // 2. X-API-Key or api-key header
  const xApiKey = req.headers['x-api-key'] || req.headers['api-key'];
  if (xApiKey && xApiKey.trim() === expectedToken) {
    return next();
  }

  // 3. Custom 'bearer' header (if header name is 'bearer')
  const bearerHeader = req.headers['bearer'];
  if (bearerHeader) {
    const val = bearerHeader.startsWith('Bearer ') ? bearerHeader.substring(7).trim() : bearerHeader.trim();
    if (val === expectedToken) return next();
  }

  // 4. URL query parameter (?token=... or ?apiKey=...)
  const queryToken = req.query.token || req.query.key || req.query.apiKey;
  if (queryToken && queryToken.trim() === expectedToken) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Missing or invalid MCP access token.' });
};

// Initialize MCP Server instance & SSE Transport Map
const mcpServer = createMcpServer(db, client, model);
const sseTransports = new Map();

// SSE endpoint for Claude Desktop / Mobile connection
app.get('/mcp/sse', mcpAuthMiddleware, async (req, res) => {
  console.log('New MCP SSE connection initiated');
  const transport = new SSEServerTransport('/mcp/messages', res);
  const sessionId = transport.sessionId;
  sseTransports.set(sessionId, transport);

  req.on('close', () => {
    console.log(`MCP SSE connection closed: ${sessionId}`);
    sseTransports.delete(sessionId);
  });

  await mcpServer.connect(transport);
});

// POST endpoint to handle client messages in SSE session
app.post('/mcp/messages', mcpAuthMiddleware, express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }
  await transport.handlePostMessage(req, res);
});

// Streamable HTTP transport (Official modern MCP Transport)
const streamableTransport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true
});
const streamableMcpServer = createMcpServer(db, client, model);
streamableMcpServer.connect(streamableTransport);

// Streamable HTTP endpoint: handles both GET and POST on /mcp
app.all('/mcp', mcpAuthMiddleware, express.json(), async (req, res) => {
  try {
    await streamableTransport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP Streamable HTTP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Scheduled Morning Briefing Push
async function runMorningBriefingPush() {
  try {
    const targetLineId = process.env.MORNING_BRIEF_LINE_ID;
    if (!targetLineId) {
      console.log('MORNING_BRIEF_LINE_ID not set. Skipping automated morning push.');
      return;
    }

    console.log(`Running automated Morning Briefing push to ${targetLineId}...`);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const chatsSnapshot = await db.collection('chats').get();

    let allMessages = [];
    for (const chatDoc of chatsSnapshot.docs) {
      const chatId = chatDoc.id;
      const chatData = chatDoc.data();
      const chatName = chatData.groupName || chatData.name || chatId;

      const msgSnapshot = await db.collection('chats')
        .doc(chatId)
        .collection('messages')
        .where('timestamp', '>=', cutoff)
        .get();

      msgSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.text) {
          allMessages.push({
            chatName,
            sender: data.displayName || data.userId || 'User',
            text: data.text,
            time: data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : ''
          });
        }
      });
    }

    if (allMessages.length > 0) {
      const prompt = `You are a personal executive AI assistant preparing a Morning Briefing.
Analyze the following ${allMessages.length} LINE messages from the last 24 hours:

${JSON.stringify(allMessages, null, 2)}

Provide a concise Executive Morning Briefing in Markdown formatted for a LINE message:
1. 🚨 **Attention Needed / Urgent Items**
2. 📌 **Group Highlights**
3. ✅ **Pending Action Items**`;

      const result = await generateContentWithRetry(prompt);
      const messages = splitIntoMessages(`🌅 **Good Morning! Executive Daily Briefing**\n\n${result}`);
      await sendLineMessages(client, null, targetLineId, messages);
      console.log('Morning Briefing pushed successfully!');
    } else {
      console.log('No overnight messages found. Morning briefing push skipped.');
    }
  } catch (error) {
    console.error('Error during morning briefing push:', error);
  }
}

// Hourly check for morning briefing time (8:00 AM)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() === 0) {
    runMorningBriefingPush();
  }
}, 60000);

// Scheduled Daily Storage Cleanup (3:00 AM daily - removes non-important images older than 90 days)
async function runDailyImageCleanup(daysOverride = null) {
  try {
    const daysThreshold = daysOverride !== null ? daysOverride : (parseInt(process.env.IMAGE_RETENTION_DAYS, 10) || 90);
    console.log(`Running daily cleanup of old non-important images older than ${daysThreshold} days...`);
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000); // 90 days
    const snapshot = await db.collection('chat_images')
      .where('timestamp', '<=', cutoff)
      .get();

    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'line-bot-sumarizer.appspot.com';
    let bucket;
    try {
      bucket = admin.storage().bucket(bucketName);
    } catch (e) {
      bucket = admin.storage().bucket();
    }

    let count = 0;
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.isImportant === true || data.deletedFromStorage === true) {
        continue;
      }
      if (data.storagePath) {
        try {
          await bucket.file(data.storagePath).delete({ ignoreNotFound: true });
        } catch (e) {}
      }
      await doc.ref.update({
        deletedFromStorage: true,
        base64Thumb: admin.firestore.FieldValue.delete(),
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      count++;
    }
    console.log(`Daily image cleanup completed (${daysThreshold}d retention). Cleaned ${count} images.`);
  } catch (err) {
    console.error('Error during daily image cleanup:', err);
  }
}

// Check every minute if it is 3:00 AM for image cleanup
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 3 && now.getMinutes() === 0) {
    runDailyImageCleanup();
  }
}, 60000);

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

// Helper to convert readable stream to Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// vCard 3.0 String Generator
function generateVCard(data) {
  const firstName = data.firstName || '';
  const lastName = data.lastName || '';
  const fn = `${firstName} ${lastName}`.trim() || 'Scanned Contact';
  const n = `${lastName};${firstName};;;`;

  let vcard = 'BEGIN:VCARD\r\n';
  vcard += 'VERSION:3.0\r\n';
  vcard += `FN:${fn}\r\n`;
  vcard += `N:${n}\r\n`;
  if (data.company) vcard += `ORG:${data.company}\r\n`;
  if (data.jobTitle) vcard += `TITLE:${data.jobTitle}\r\n`;
  if (data.email) vcard += `EMAIL;TYPE=INTERNET,WORK:${data.email}\r\n`;
  if (data.phone) vcard += `TEL;TYPE=CELL,VOICE:${data.phone}\r\n`;
  if (data.website) vcard += `URL:${data.website}\r\n`;
  if (data.lineId) {
    const cleanLine = data.lineId.replace(/^@/, '');
    vcard += `X-SOCIALPROFILE;type=line:https://line.me/ti/p/~${cleanLine}\r\n`;
  }
  vcard += 'END:VCARD\r\n';
  return vcard;
}

// Helper to check if /newcontact 15-second timer window is active
async function isNewContactSessionActive(chatsId) {
  try {
    const chatDoc = await db.collection('chats').doc(chatsId).get();
    if (chatDoc.exists) {
      const session = chatDoc.data().newcontactSession;
      if (session && session.active && Date.now() <= session.expiresAt) {
        return true;
      }
    }

    // Fallback: check if /newcontact message was sent in last 15 seconds
    const snapshot = await db.collection('chats')
      .doc(chatsId)
      .collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(3)
      .get();

    if (snapshot.empty) return false;
    const fifteenSecsAgo = Date.now() - 15 * 1000;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const msgTime = data.timestamp?.toDate?.() ? data.timestamp.toDate().getTime() : Date.now();
      if (msgTime < fifteenSecsAgo) break;
      if (data.text && data.text.trim().toLowerCase().includes('/newcontact')) {
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('Error checking active /newcontact session:', err);
    return false;
  }
}

// Helper to find recent image message ID in chat (last 15 seconds)
async function getRecentImageMessageId(chatsId) {
  try {
    const snapshot = await db.collection('chats')
      .doc(chatsId)
      .collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(5)
      .get();

    if (snapshot.empty) return null;
    const fifteenSecsAgo = Date.now() - 15 * 1000;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const msgTime = data.timestamp?.toDate?.() ? data.timestamp.toDate().getTime() : Date.now();
      if (msgTime < fifteenSecsAgo) break;
      if (data.messageType === 'image' && data.messageId) {
        return data.messageId;
      }
    }
    return null;
  } catch (err) {
    console.error('Error finding recent image message ID:', err);
    return null;
  }
}

// Business Card Scanner Feature (Multimodal LLM + vCard + Firebase Storage)
async function processBusinessCardImage(client, event, targetMessageId = null) {
  try {
    const messageId = targetMessageId || event.message.id;
    console.log(`Processing business card image for message ID: ${messageId}`);

    // 1. Download image stream from LINE Messaging API
    const stream = await client.getMessageContent(messageId);
    const imageBuffer = await streamToBuffer(stream);

    // 2. LLM Processing with Gemini
    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const prompt = `Extract contact information from this business card. Return a strictly formatted JSON object with the keys: firstName, lastName, company, jobTitle, email, phone, website, and lineId.

Translation Rule: If the text is in simplified Chinese, Arabic, or any language other than English, translate it to English. You MUST append the original script in parentheses next to the English translation (e.g., 'Name: John Doe (张伟)').`;

    await geminiRateLimiter.waitForSlot();
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const rawText = response.text();

    console.log('Raw Gemini OCR result:', rawText);

    // Parse JSON safely
    let cleanedText = rawText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    let contactData = {};
    try {
      contactData = JSON.parse(cleanedText);
    } catch (parseErr) {
      console.error('JSON parse error from Gemini output:', parseErr, 'Raw output:', rawText);
      contactData = {
        firstName: 'Scanned',
        lastName: 'Contact',
        company: null,
        jobTitle: null,
        email: null,
        phone: null,
        website: null,
        lineId: null,
      };
    }

    // 3. Construct vCard string
    const vcardContent = generateVCard(contactData);

    // 4. Upload vCard & Hero Image to Firebase Cloud Storage & generate signed URLs
    let signedUrl = null;
    let heroImageUrl = null;
    const safeName = (contactData.firstName || 'contact').replace(/[^a-zA-Z0-9]/g, '_');
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'line-bot-sumarizer.appspot.com';
    let bucket;
    try {
      bucket = admin.storage().bucket(bucketName);
    } catch (e) {
      bucket = admin.storage().bucket();
    }

    // Upload vCard (.vcf)
    try {
      const fileName = `vcards/card_${safeName}_${Date.now()}.vcf`;
      const file = bucket.file(fileName);

      await file.save(vcardContent, {
        contentType: 'text/vcard',
        metadata: { contentType: 'text/vcard' },
      });

      const [vcfUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      });
      signedUrl = vcfUrl;
      console.log('vCard uploaded successfully. Signed URL:', signedUrl);
    } catch (storageErr) {
      console.warn('Firebase Storage vCard upload warning:', storageErr.message);
    }

    // Upload Business Card Image (Hero)
    try {
      const imgFileName = `card_images/card_${safeName}_${Date.now()}.jpg`;
      const imgFile = bucket.file(imgFileName);

      await imgFile.save(imageBuffer, {
        contentType: 'image/jpeg',
        metadata: { contentType: 'image/jpeg' },
      });

      const [imgUrl] = await imgFile.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      });
      heroImageUrl = imgUrl;
      console.log('Hero image uploaded successfully. Signed URL:', heroImageUrl);
    } catch (imgStorageErr) {
      console.warn('Firebase Storage Hero image upload warning:', imgStorageErr.message);
    }

    // 5. Construct LINE Reply Message (User Specified Flex Message JSON)
    const displayName = `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim() || 'Scanned Contact';
    
    const bodyContents = [
      {
        type: 'text',
        text: displayName,
        weight: 'bold',
        size: 'xl',
        margin: 'md'
      }
    ];

    if (contactData.jobTitle) {
      bodyContents.push({
        type: 'text',
        text: contactData.jobTitle,
        size: 'sm',
        color: '#888888',
        weight: 'bold',
        wrap: true
      });
    }

    if (contactData.company) {
      bodyContents.push({
        type: 'text',
        text: contactData.company,
        size: 'xs',
        color: '#aaaaaa',
        wrap: true
      });
    }

    bodyContents.push({
      type: 'separator',
      margin: 'xxl'
    });

    const contactRows = [];

    if (contactData.phone) {
      const cleanPhone = contactData.phone.replace(/[^0-9+]/g, '');
      contactRows.push({
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: 'Mobile',
            size: 'sm',
            color: '#555555',
            flex: 1
          },
          {
            type: 'text',
            text: contactData.phone,
            size: 'sm',
            color: '#111111',
            flex: 2,
            align: 'end',
            action: {
              type: 'uri',
              label: 'Call',
              uri: `tel:${cleanPhone}`
            }
          }
        ]
      });
    }

    if (contactData.lineId) {
      const rawLineId = contactData.lineId.trim();
      const displayLineId = rawLineId.startsWith('@') ? rawLineId : `@${rawLineId}`;
      const cleanLineId = rawLineId.replace(/^@/, '');
      contactRows.push({
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: 'LINE',
            size: 'sm',
            color: '#555555',
            flex: 1
          },
          {
            type: 'text',
            text: displayLineId,
            size: 'sm',
            color: '#111111',
            flex: 2,
            align: 'end',
            action: {
              type: 'uri',
              label: 'Add LINE',
              uri: `https://line.me/ti/p/~${cleanLineId}`
            }
          }
        ]
      });
    }

    if (contactData.email) {
      contactRows.push({
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: 'Email',
            size: 'sm',
            color: '#555555',
            flex: 1
          },
          {
            type: 'text',
            text: contactData.email,
            size: 'sm',
            color: '#111111',
            flex: 2,
            align: 'end',
            wrap: true,
            action: {
              type: 'uri',
              label: 'Mail',
              uri: `mailto:${contactData.email}`
            }
          }
        ]
      });
    }

    if (contactData.website) {
      const cleanWeb = contactData.website.startsWith('http') ? contactData.website : `https://${contactData.website}`;
      contactRows.push({
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: 'Website',
            size: 'sm',
            color: '#555555',
            flex: 1
          },
          {
            type: 'text',
            text: contactData.website,
            size: 'sm',
            color: '#111111',
            flex: 2,
            align: 'end',
            wrap: true,
            action: {
              type: 'uri',
              label: 'Web',
              uri: cleanWeb
            }
          }
        ]
      });
    }

    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'xxl',
      spacing: 'sm',
      contents: contactRows
    });

    const footerButtons = [];

    if (signedUrl) {
      footerButtons.push({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'uri',
          label: 'Download Contact',
          uri: signedUrl
        }
      });
    }

    const googleContactsUrl = 'https://contacts.google.com/new';
    footerButtons.push({
      type: 'button',
      style: 'primary',
      height: 'sm',
      color: '#4285F4',
      action: {
        type: 'uri',
        label: 'Save to Google Contacts',
        uri: googleContactsUrl
      }
    });

    const bubbleContents = {
      type: 'bubble',
      size: 'kilo',
      ...(heroImageUrl ? {
        hero: {
          type: 'image',
          url: heroImageUrl,
          size: 'full',
          aspectRatio: '1:1',
          aspectMode: 'cover'
        }
      } : {}),
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerButtons,
        flex: 0
      }
    };

    const flexMessage = {
      type: 'flex',
      altText: `🎴 Business Card: ${displayName}`,
      contents: bubbleContents
    };

    if (event.replyToken) {
      return client.replyMessage(event.replyToken, flexMessage);
    } else {
      const chatsId = event.source.groupId || event.source.userId;
      return client.pushMessage(chatsId, flexMessage);
    }

  } catch (error) {
    console.error('Error processing business card image:', error);
    const reply = {
      type: 'text',
      text: '❌ Failed to process business card image. Please ensure the image is clear and try again.'
    };
    if (event.replyToken) {
      return client.replyMessage(event.replyToken, reply);
    } else {
      const chatsId = event.source.groupId || event.source.userId;
      return client.pushMessage(chatsId, reply);
    }
  }
}

// Process general chat images (Hybrid pipeline: Gemini vision captioning + Storage + Firestore indexing)
async function processChatImage(client, event) {
  try {
    const messageId = event.message.id;
    const chatsId = event.source.groupId || event.source.userId;
    const chatsType = event.source.groupId ? 'group' : 'user';

    console.log(`Processing hybrid image message ID: ${messageId} in ${chatsType} ${chatsId}`);

    // Get user profile & group name
    let displayName = 'Unknown User';
    let groupName = null;
    try {
      if (chatsType === 'group') {
        try {
          const profile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
          displayName = profile.displayName;
        } catch (e) {}
        try {
          const groupSummary = await client.getGroupSummary(event.source.groupId);
          groupName = groupSummary.groupName;
        } catch (e) {
          groupName = 'Unknown Group';
        }
      } else {
        try {
          const profile = await client.getProfile(event.source.userId);
          displayName = profile.displayName;
        } catch (e) {}
      }
    } catch (e) {}

    // 1. Download image stream from LINE
    const stream = await client.getMessageContent(messageId);
    const imageBuffer = await streamToBuffer(stream);

    // 2. Fast Concise Vision Summary with Gemini
    let imageSummary = 'Photo / Image attachment';
    try {
      const imagePart = {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: 'image/jpeg',
        },
      };
      const prompt = 'Describe this image concisely in 1-2 sentences for a chat log. If there are visible text, numbers, receipts, errors, slips, or charts, mention them specifically.';
      await geminiRateLimiter.waitForSlot();
      const result = await model.generateContent([prompt, imagePart]);
      const res = await result.response;
      imageSummary = res.text().trim();
    } catch (visionErr) {
      console.warn('Gemini vision captioning warning:', visionErr.message);
    }

    // 3. Save Image to Firebase Storage
    const storagePath = `chat_images/${chatsId}/${messageId}.jpg`;
    let storageSaved = false;
    try {
      const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'line-bot-sumarizer.appspot.com';
      let bucket;
      try {
        bucket = admin.storage().bucket(bucketName);
      } catch (e) {
        bucket = admin.storage().bucket();
      }
      await bucket.file(storagePath).save(imageBuffer, {
        contentType: 'image/jpeg',
        metadata: { contentType: 'image/jpeg' }
      });
      storageSaved = true;
      console.log(`Image saved to Firebase Storage at ${storagePath}`);
    } catch (storageErr) {
      console.warn('Firebase Storage upload warning:', storageErr.message);
    }

    // Save image metadata into 'chat_images' collection
    // If under 900KB, also save base64 directly in doc for instant retrieval by Claude
    const base64Thumb = imageBuffer.length < 900000 ? imageBuffer.toString('base64') : null;
    await db.collection('chat_images').doc(messageId).set({
      imageId: messageId,
      chatId: chatsId,
      chatName: groupName || displayName,
      senderId: event.source.userId,
      senderName: displayName,
      summary: imageSummary,
      storagePath: storageSaved ? storagePath : null,
      base64Thumb: base64Thumb,
      isImportant: false,
      deletedFromStorage: false,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Save message into chats/{chatsId}/messages so Claude can read and search without downloading
    const chatDocRef = db.collection('chats').doc(chatsId);
    await chatDocRef.set({
      chatsId: chatsId,
      chatsType: chatsType,
      groupName: groupName,
      lastActivity: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const messageData = {
      messageId: messageId,
      messageType: 'image',
      imageId: messageId,
      text: `📷 [Image: ${imageSummary}] (Image ID: ${messageId})`,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      eventType: event.type,
      userId: event.source.userId,
      displayName: displayName,
      groupName: groupName,
      chatsId: chatsId,
      chatsType: chatsType
    };

    await chatDocRef.collection('messages').add(messageData);
    console.log(`Saved image message with summary to Firestore for ${chatsType} from ${displayName}: ${imageSummary}`);

    return Promise.resolve(null);
  } catch (error) {
    console.error('Error in processChatImage:', error);
    return Promise.resolve(null);
  }
}

// --- 3. DEFINE THE EVENT HANDLER ---
// This function handles the incoming messages
async function handleEvent(event) {
  if (!event || event.type !== 'message') {
    return Promise.resolve(null);
  }

  const chatsId = event.source.groupId || event.source.userId;

  // Handle image messages
  if (event.message.type === 'image') {
    const hasCaptionCommand = event.message.text && event.message.text.toLowerCase().includes('/newcontact');
    const isSessionActive = await isNewContactSessionActive(chatsId);

    if (hasCaptionCommand || isSessionActive) {
      console.log('Image received during active /newcontact window. Processing business card...');
      return processBusinessCardImage(client, event);
    } else {
      console.log('Image received in chat. Processing hybrid image pipeline...');
      return processChatImage(client, event);
    }
  }

  // We only want to handle text messages for standard bot commands
  if (event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  try {
    const textLower = event.message.text.trim().toLowerCase();

    // Check for /newcontact command
    if (textLower.startsWith('/newcontact')) {
      console.log('Processing /newcontact command with 15s window...');
      const now = Date.now();
      const expiresAt = now + 15000; // 15 seconds

      // 1. Reply immediately
      const reply = {
        type: 'text',
        text: 'Uploading business card(s) within 15 sec.'
      };
      await client.replyMessage(event.replyToken, reply);

      // 2. Save active session in Firestore
      await db.collection('chats').doc(chatsId).set({
        newcontactSession: {
          active: true,
          startTime: now,
          expiresAt: expiresAt
        }
      }, { merge: true });

      // Check if an image was uploaded immediately preceding /newcontact
      const recentImageId = await getRecentImageMessageId(chatsId);
      if (recentImageId) {
        console.log(`Found recent image ID ${recentImageId} for /newcontact. Processing business card...`);
        await processBusinessCardImage(client, { source: event.source }, recentImageId);
      }

      // 3. Start 15-second timer for timeout response
      setTimeout(async () => {
        try {
          // Deactivate session in Firestore
          await db.collection('chats').doc(chatsId).set({
            newcontactSession: { active: false }
          }, { merge: true });

          console.log(`15s timer expired for /newcontact in chat ${chatsId}. Sending timeout message...`);
          await client.pushMessage(chatsId, {
            type: 'text',
            text: 'Uploading timed out'
          });
        } catch (timerErr) {
          console.error('Error handling /newcontact timeout:', timerErr);
        }
      }, 15000);

      return Promise.resolve(null);
    }

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
    
    if (event.message.text.toLowerCase() === '/help' || event.message.text.toLowerCase() === '/?') {
      const helpText = `🤖 **LINE Summary Bot**

AI-powered bot for group summaries, business card scanning, and code matching.

**Available Commands & Features:**
• /sumgroup - Generate AI summaries for all group chats
• /sumdirect - Analyze direct messages with code matching
• /newcontact - Extract contact details from business card & get downloadable .vcf file!
• /updatecode - Refresh code database from Google Sheets
• /status - Show system uptime and statistics
• /help or /? - Show this help message

💡 Send any code to get its link, or send a business card image with /newcontact!`;

      const reply = { type: 'text', text: helpText };
      return client.replyMessage(event.replyToken, reply);
    }
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