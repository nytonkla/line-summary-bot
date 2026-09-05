// mcp-server.js
// Model Context Protocol (MCP) server for line-summary-bot
require('dotenv').config();
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const admin = require('firebase-admin');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Creates and initializes an MCP Server instance registered with all line-summary-bot tools.
 * @param {admin.firestore.Firestore} db - Firestore database instance
 * @param {line.messagingApi.MessagingApiClient} lineClient - LINE messaging API client
 * @param {Object} genAIModel - Gemini generative AI model instance
 */
function createMcpServer(db, lineClient, genAIModel) {
  const server = new McpServer({
    name: 'line-summary-bot-mcp',
    version: '1.0.0',
    description: 'Personal executive assistant MCP server for LINE Summary Bot'
  });

  // -------------------------------------------------------------
  // Tool 1: list_chats
  // -------------------------------------------------------------
  server.tool(
    'list_chats',
    'Lists active LINE chat rooms, group chats, and 1-on-1 conversations with metadata.',
    {
      limit: z.number().optional().default(20).describe('Maximum number of chats to return')
    },
    async ({ limit }) => {
      try {
        const snapshot = await db.collection('chats').limit(limit).get();
        const chats = [];
        snapshot.forEach(doc => {
          const data = doc.data();
          chats.push({
            id: doc.id,
            chatType: data.chatType || 'unknown',
            groupName: data.groupName || data.name || 'Unnamed Chat',
            lastSummaryTimestamp: data.lastSummaryTimestamp || null,
            updatedAt: data.updatedAt ? (data.updatedAt.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt) : null
          });
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: chats.length, chats }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to list chats: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 2: get_chat_history
  // -------------------------------------------------------------
  server.tool(
    'get_chat_history',
    'Retrieves messages for a specific chat or across all chats within a timeframe. Returns text messages and AI-captioned image summaries (marked with [Image: ...] and imageId, which can be viewed with get_chat_image).',
    {
      chatId: z.string().optional().describe('ID of specific chat room. If omitted, pulls across all chats.'),
      limit: z.number().optional().default(50).describe('Maximum number of messages to return'),
      hoursBack: z.number().optional().describe('Fetch messages from the last N hours')
    },
    async ({ chatId, limit, hoursBack }) => {
      try {
        let messages = [];

        if (chatId) {
          let query = db.collection('chats').doc(chatId).collection('messages');
          if (hoursBack) {
            const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
            query = query.where('timestamp', '>=', cutoff);
          }
          const snapshot = await query.limit(limit).get();
          snapshot.forEach(doc => {
            const data = doc.data();
            messages.push({
              id: doc.id,
              chatId,
              senderId: data.userId || data.senderId || 'unknown',
              senderName: data.displayName || data.senderName || 'User',
              text: data.text || data.message || '',
              messageType: data.messageType || 'text',
              imageId: data.imageId || (data.messageType === 'image' ? (data.messageId || doc.id) : null),
              timestamp: data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : null
            });
          });
        } else {
          // Cross-chat query: iterate through active chats to avoid requiring collection group indexes
          const chatsSnapshot = await db.collection('chats').limit(20).get();
          const cutoff = hoursBack ? new Date(Date.now() - hoursBack * 60 * 60 * 1000) : null;

          for (const chatDoc of chatsSnapshot.docs) {
            let query = db.collection('chats').doc(chatDoc.id).collection('messages');
            if (cutoff) {
              query = query.where('timestamp', '>=', cutoff);
            }
            const snapshot = await query.limit(Math.ceil(limit / Math.max(chatsSnapshot.size, 1)) || 20).get();
            snapshot.forEach(doc => {
              const data = doc.data();
              messages.push({
                id: doc.id,
                chatId: chatDoc.id,
                chatName: chatDoc.data().groupName || chatDoc.data().name || chatDoc.id,
                senderId: data.userId || data.senderId || 'unknown',
                senderName: data.displayName || data.senderName || 'User',
                text: data.text || data.message || '',
                messageType: data.messageType || 'text',
                imageId: data.imageId || (data.messageType === 'image' ? (data.messageId || doc.id) : null),
                timestamp: data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : null
              });
            });
            if (messages.length >= limit) break;
          }
        }
        const imageCount = messages.filter(m => m.messageType === 'image' || m.imageId).length;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                count: messages.length,
                imageCount,
                imageNotice: imageCount > 0
                  ? "Found image messages! Use get_chat_image({ imageId }) with any imageId below to download and visually inspect the full image in Claude."
                  : "No image messages found in this timeframe. Note: The bot fully supports images! When images are sent in LINE, they are saved with AI vision summaries and imageIds, which can be viewed with get_chat_image({ imageId }).",
                messages
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to get chat history: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 3: get_morning_briefing
  // -------------------------------------------------------------
  server.tool(
    'get_morning_briefing',
    'Generates a structured executive morning summary of overnight messages across all groups, categorized by urgency and action items.',
    {
      hoursBack: z.number().optional().default(24).describe('Time window in hours (default: 24h)')
    },
    async ({ hoursBack }) => {
      try {
        const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
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
                messageType: data.messageType || 'text',
                imageId: data.imageId || (data.messageType === 'image' ? (data.messageId || doc.id) : null),
                time: data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : ''
              });
            }
          });
        }

        if (allMessages.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No new messages recorded in the specified timeframe for the morning briefing.'
              }
            ]
          };
        }

        const prompt = `You are a personal executive AI assistant preparing a Morning Briefing for your user.
Analyze the following ${allMessages.length} LINE messages from the last ${hoursBack} hours:

${JSON.stringify(allMessages, null, 2)}

Provide a concise, high-level Executive Morning Briefing in Markdown:
1. 🚨 **Attention Needed / Urgent Items**: Direct questions to the user, explicit requests, or urgent tasks.
2. 📌 **Group Highlights**: Key developments per chat group.
3. ✅ **Pending Action Items**: Tasks that require follow-up.
4. 💡 **Suggested Responses**: Draft answers for high-priority items.`;

        let summaryText = '';
        if (genAIModel) {
          try {
            const result = await genAIModel.generateContent(prompt);
            const response = await result.response;
            summaryText = response.text();
          } catch (e) {
            summaryText = `Found ${allMessages.length} messages. Synthesis fallback used.`;
          }
        }

        // Return structured JSON containing all overnight messages + pre-synthesis
        // so Claude can generate the ultimate executive morning brief natively.
        const outputPayload = {
          totalMessages: allMessages.length,
          timeframeHours: hoursBack,
          messagesByGroup: allMessages,
          preSynthesizedBriefing: summaryText
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(outputPayload, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to generate morning briefing: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 4: get_attention_items
  // -------------------------------------------------------------
  server.tool(
    'get_attention_items',
    'Extracts questions asked directly to you, mentions, unresolved requests, and high-priority action items across chats.',
    {
      hoursBack: z.number().optional().default(24).describe('Time window in hours')
    },
    async ({ hoursBack }) => {
      try {
        const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
        const chatsSnapshot = await db.collection('chats').limit(20).get();
        const attentionItems = [];
        const questionRegex = /\?|ช่วย|รบกวน|ด่วน|urgent|please|how|what|when|where|why|can you/i;

        for (const chatDoc of chatsSnapshot.docs) {
          const chatId = chatDoc.id;
          const chatName = chatDoc.data().groupName || chatDoc.data().name || chatId;
          const msgSnapshot = await db.collection('chats')
            .doc(chatId)
            .collection('messages')
            .where('timestamp', '>=', cutoff)
            .limit(100)
            .get();

          msgSnapshot.forEach(doc => {
            const data = doc.data();
            const text = data.text || '';
            if (questionRegex.test(text)) {
              attentionItems.push({
                id: doc.id,
                chatId,
                chatName,
                sender: data.displayName || data.userId || 'User',
                text,
                messageType: data.messageType || 'text',
                imageId: data.imageId || (data.messageType === 'image' ? (data.messageId || doc.id) : null),
                timestamp: data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : null
              });
            }
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: attentionItems.length, items: attentionItems }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to fetch attention items: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 5: search_messages
  // -------------------------------------------------------------
  server.tool(
    'search_messages',
    'Performs full-text search across all stored LINE chat histories by keyword or phrase.',
    {
      query: z.string().describe('Keyword or term to search for'),
      limit: z.number().optional().default(20).describe('Max results')
    },
    async ({ query, limit }) => {
      try {
        const snapshot = await db.collectionGroup('messages').limit(200).get();
        const matched = [];
        const lowerQuery = query.toLowerCase();

        snapshot.forEach(doc => {
          const data = doc.data();
          const text = data.text || '';
          if (text.toLowerCase().includes(lowerQuery)) {
            matched.push({
              id: doc.id,
              sender: data.displayName || data.userId || 'User',
              text,
              messageType: data.messageType || 'text',
              imageId: data.imageId || (data.messageType === 'image' ? (data.messageId || doc.id) : null),
              timestamp: data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : null
            });

            if (matched.length >= limit) return;
          }
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ query, matchCount: matched.length, results: matched }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to search messages: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 6: send_line_message
  // -------------------------------------------------------------
  server.tool(
    'send_line_message',
    'Proactively sends a LINE message to a specified chat room or user ID (for approved drafts or alerts).',
    {
      targetId: z.string().describe('LINE chat room ID, group ID, or user ID'),
      message: z.string().describe('Message content to send')
    },
    async ({ targetId, message }) => {
      try {
        if (!lineClient) {
          throw new Error('LINE client is not initialized in this environment.');
        }

        await lineClient.pushMessage(targetId, {
          type: 'text',
          text: message
        });

        await db.collection('commands').add({
          action: 'send_line_message_mcp',
          targetId,
          message,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          content: [
            {
              type: 'text',
              text: `Message successfully sent to ${targetId}`
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to send LINE message: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 7: add_memory
  // -------------------------------------------------------------
  server.tool(
    'add_memory',
    'Stores a key decision, project fact, contact info, deadline, or link into the Firestore structured memories collection.',
    {
      title: z.string().describe('Title or brief summary of the memory'),
      content: z.string().describe('Detailed content, facts, or context'),
      category: z.enum(['decision', 'deadline', 'contact', 'link', 'project_fact', 'other']).default('project_fact'),
      chatId: z.string().optional().describe('Associated LINE chat room ID if applicable')
    },
    async ({ title, content, category, chatId }) => {
      try {
        const memoryDoc = {
          title,
          content,
          category,
          chatId: chatId || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const ref = await db.collection('memories').add(memoryDoc);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, memoryId: ref.id, title, category }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to add memory: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 8: search_memories
  // -------------------------------------------------------------
  server.tool(
    'search_memories',
    'Searches stored structured memories and project facts by keyword or category.',
    {
      query: z.string().optional().describe('Keyword to filter memory title and content'),
      category: z.string().optional().describe('Filter by memory category'),
      limit: z.number().optional().default(20)
    },
    async ({ query, category, limit }) => {
      try {
        let queryRef = db.collection('memories');
        if (category) {
          queryRef = queryRef.where('category', '==', category);
        }

        const snapshot = await queryRef.limit(limit).get();
        const memories = [];
        const lowerQuery = query ? query.toLowerCase() : null;

        snapshot.forEach(doc => {
          const data = doc.data();
          const textToMatch = `${data.title || ''} ${data.content || ''}`.toLowerCase();
          if (!lowerQuery || textToMatch.includes(lowerQuery)) {
            memories.push({
              id: doc.id,
              title: data.title,
              content: data.content,
              category: data.category,
              chatId: data.chatId,
              createdAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null
            });
          }
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ count: memories.length, memories }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to search memories: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 9: get_bot_rules
  // -------------------------------------------------------------
  server.tool(
    'get_bot_rules',
    'Retrieves auto-reply policies, response mode (drafting vs autonomous), permitted keywords, and confidence rules.',
    {},
    async () => {
      try {
        const doc = await db.collection('bot_rules').doc('config').get();
        const data = doc.exists ? doc.data() : {
          mode: 'drafting',
          allowedTopics: ['business_hours', 'faq'],
          confidenceThreshold: 0.85
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to fetch bot rules: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 10: set_bot_rule
  // -------------------------------------------------------------
  server.tool(
    'set_bot_rule',
    'Configures or updates auto-response permissions and rules (e.g. switching between drafting and autonomous modes).',
    {
      mode: z.enum(['drafting', 'autonomous']).optional().describe('Response mode'),
      allowedTopics: z.array(z.string()).optional().describe('Topics bot is permitted to respond to'),
      confidenceThreshold: z.number().optional().describe('Confidence threshold for auto-replying (0.0 to 1.0)')
    },
    async ({ mode, allowedTopics, confidenceThreshold }) => {
      try {
        const updateData = {
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (mode) updateData.mode = mode;
        if (allowedTopics) updateData.allowedTopics = allowedTopics;
        if (confidenceThreshold !== undefined) updateData.confidenceThreshold = confidenceThreshold;

        await db.collection('bot_rules').doc('config').set(updateData, { merge: true });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, updatedConfig: updateData }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to update bot rules: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 11: get_chat_image
  // -------------------------------------------------------------
  server.tool(
    'get_chat_image',
    'Downloads and displays an image sent in a LINE chat so Claude can visually inspect, read, or analyze it.',
    {
      imageId: z.string().describe('ID of the image message to view')
    },
    async ({ imageId }) => {
      try {
        const imageDoc = await db.collection('chat_images').doc(imageId).get();
        if (!imageDoc.exists) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Image record not found for ID: ${imageId}` }]
          };
        }

        const data = imageDoc.data();
        let base64Data = data.base64Thumb;

        if (!base64Data && data.storagePath) {
          const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'line-bot-sumarizer.appspot.com';
          let bucket;
          try {
            bucket = admin.storage().bucket(bucketName);
          } catch (e) {
            bucket = admin.storage().bucket();
          }
          const file = bucket.file(data.storagePath);
          const [fileBuffer] = await file.download();
          base64Data = fileBuffer.toString('base64');
        }

        if (!base64Data) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Image data is no longer available in storage for image ID: ${imageId} (Summary: ${data.summary || 'N/A'})` }]
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `📷 Image ID: ${imageId}\nSender: ${data.senderName || 'Unknown'}\nChat: ${data.chatName || data.chatId || 'LINE Chat'}\nSummary: ${data.summary || 'N/A'}\nImportant: ${data.isImportant ? 'Yes ⭐' : 'No'}`
            },
            {
              type: 'image',
              data: base64Data,
              mimeType: 'image/jpeg'
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to retrieve image: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 12: mark_image_important
  // -------------------------------------------------------------
  server.tool(
    'mark_image_important',
    'Tags an image as important (or un-marks it) to prevent it from ever being deleted by automated storage cleanup routines.',
    {
      imageId: z.string().describe('ID of the image message'),
      isImportant: z.boolean().default(true).describe('True to protect from cleanup, false to allow cleanup'),
      notes: z.string().optional().describe('Why this image is important (e.g. "Tax receipt", "Architecture diagram")')
    },
    async ({ imageId, isImportant, notes }) => {
      try {
        const updateData = {
          isImportant,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (notes) updateData.notes = notes;

        await db.collection('chat_images').doc(imageId).set(updateData, { merge: true });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, imageId, isImportant, notes: notes || null }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to mark image: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 13: cleanup_old_images
  // -------------------------------------------------------------
  server.tool(
    'cleanup_old_images',
    'Cleans up non-important images from storage older than N days (keeps text summaries in chat history).',
    {
      daysOld: z.number().optional().default(90).describe('Delete images older than this many days (default: 90)'),
      dryRun: z.boolean().optional().default(false).describe('If true, previews images that would be deleted without actually deleting them')
    },
    async ({ daysOld, dryRun }) => {
      try {
        const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
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

        const candidates = [];
        let deletedCount = 0;

        for (const doc of snapshot.docs) {
          const data = doc.data();
          if (data.isImportant === true || data.deletedFromStorage === true) {
            continue;
          }

          candidates.push({
            imageId: doc.id,
            summary: data.summary,
            chatName: data.chatName,
            timestamp: data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : null
          });

          if (!dryRun) {
            if (data.storagePath) {
              try {
                await bucket.file(data.storagePath).delete({ ignoreNotFound: true });
              } catch (delErr) {
                console.warn(`Could not delete storage file ${data.storagePath}:`, delErr.message);
              }
            }
            await doc.ref.update({
              deletedFromStorage: true,
              base64Thumb: admin.firestore.FieldValue.delete(),
              deletedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            deletedCount++;
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                dryRun,
                daysThreshold: daysOld,
                totalEligible: candidates.length,
                deletedCount: dryRun ? 0 : deletedCount,
                images: candidates
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to cleanup images: ${error.message}` }]
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 14: get_storage_usage
  // -------------------------------------------------------------
  server.tool(
    'get_storage_usage',
    'Analyzes Firebase Storage usage, total image counts, size in MB/GB, protected vs purgeable items, and storage quota health.',
    {},
    async () => {
      try {
        const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'line-bot-sumarizer.appspot.com';
        let bucket;
        try {
          bucket = admin.storage().bucket(bucketName);
        } catch (e) {
          bucket = admin.storage().bucket();
        }

        let totalSizeBytes = 0;
        let fileCount = 0;

        try {
          const [files] = await bucket.getFiles({ prefix: 'chat_images/' });
          fileCount = files.length;
          files.forEach(f => {
            totalSizeBytes += parseInt(f.metadata.size || '0', 10);
          });
        } catch (bucketErr) {
          console.warn('Could not inspect storage bucket directly:', bucketErr.message);
        }

        const imagesSnapshot = await db.collection('chat_images').get();
        let totalRecords = imagesSnapshot.size;
        let importantCount = 0;
        let deletedFromStorageCount = 0;
        let oldestDate = null;
        let newestDate = null;

        imagesSnapshot.forEach(doc => {
          const data = doc.data();
          if (data.isImportant === true) importantCount++;
          if (data.deletedFromStorage === true) deletedFromStorageCount++;

          if (data.timestamp) {
            const d = data.timestamp.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
            if (!oldestDate || d < oldestDate) oldestDate = d;
            if (!newestDate || d > newestDate) newestDate = d;
          }
        });

        const totalSizeMB = (totalSizeBytes / (1024 * 1024)).toFixed(2);
        const freeTierLimitMB = 5120; // 5 GB Firebase free tier limit
        const percentUsed = ((parseFloat(totalSizeMB) / freeTierLimitMB) * 100).toFixed(1);

        const analysis = {
          storageBucket: bucketName,
          totalFilesStored: fileCount,
          totalSizeMB: parseFloat(totalSizeMB),
          totalSizeGB: (totalSizeBytes / (1024 * 1024 * 1024)).toFixed(3),
          freeTierQuotaMB: freeTierLimitMB,
          freeTierPercentUsed: `${percentUsed}%`,
          quotaStatus: parseFloat(percentUsed) > 80 ? '⚠️ High Storage Warning' : '✅ Healthy',
          databaseRecords: {
            totalImageRecords: totalRecords,
            markedImportantProtected: importantCount,
            purgedFromStorage: deletedFromStorageCount,
            activeFilesInStorage: totalRecords - deletedFromStorageCount
          },
          retentionPolicy: 'Auto-cleanup set to 90 days for non-important images',
          oldestImageDate: oldestDate ? oldestDate.toISOString() : 'N/A',
          newestImageDate: newestDate ? newestDate.toISOString() : 'N/A'
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(analysis, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to analyze storage usage: ${error.message}` }]
        };
      }
    }
  );

  return server;
}

// Stdio standalone mode execution
if (require.main === module) {
  try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    const db = admin.firestore();

    const lineClient = new line.Client({
      channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.CHANNEL_SECRET
    });

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const genAIModel = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });

    const server = createMcpServer(db, lineClient, genAIModel);
    const transport = new StdioServerTransport();
    server.connect(transport);
    console.error('LINE Summary Bot MCP Server running on stdio');
  } catch (err) {
    console.error('Failed to start MCP server on stdio:', err);
    process.exit(1);
  }
}

const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

module.exports = { createMcpServer, SSEServerTransport, StreamableHTTPServerTransport };
