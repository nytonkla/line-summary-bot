# LINE Summary Bot

A LINE bot that integrates with Firebase for message storage and Google Gemini AI for conversation summarization.

## Features

- 📱 LINE Bot integration with webhook support
- 🔥 Firebase/Firestore for message storage
- 🤖 Google Gemini AI for intelligent conversation summarization
- 📝 `/summarize` command to get AI-generated summaries of recent conversations
- 🔒 Secure environment variable configuration

## Commands

- `/summarize` - Generates an AI summary of the last 20 messages in the conversation

## Deployment on Firebase Cloud Functions

### Prerequisites

1. Firebase project (`line-bot-sumarizer`) with Firestore & Storage enabled
2. LINE Bot channel with Messaging API enabled
3. Google AI Studio API key (Gemini 1.5 Flash)
4. Firebase CLI installed (`npm install -g firebase-tools`)

### Steps to Deploy

1. **Install dependencies:**
   ```bash
   cd functions
   npm install
   ```

2. **Configure Environment Variables:**
   Ensure `functions/.env` contains your API keys:
   ```env
   CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
   CHANNEL_SECRET=your_line_channel_secret
   GEMINI_API_KEY=your_gemini_api_key
   FIREBASE_STORAGE_BUCKET=line-bot-sumarizer.firebasestorage.app
   MCP_ACCESS_TOKEN=your_mcp_access_token
   ```

3. **Deploy to Firebase:**
   ```bash
   cd functions
   npx firebase deploy --only functions
   ```

4. **Configure LINE Webhook:**
   - Go to [LINE Developers Console](https://developers.line.biz/console/)
   - Set **Webhook URL** to:
     ```
     https://us-central1-line-bot-sumarizer.cloudfunctions.net/lineSummaryBot/webhook
     ```
   - Enable **Use webhook** (toggle to ON)
   - Click **Verify** to test connection

5. **Connect Claude (MCP):**
   - Connect Claude Desktop or Claude Mobile to:
     ```
     https://us-central1-line-bot-sumarizer.cloudfunctions.net/lineSummaryBot/mcp
     ```

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env` file:**
   ```env
   CHANNEL_ACCESS_TOKEN=your_channel_access_token
   CHANNEL_SECRET=your_channel_secret
   GEMINI_API_KEY=your_gemini_api_key
   FIREBASE_PROJECT_ID=your_firebase_project_id
   FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com
   ```

3. **Add Firebase service account key:**
   - Download `serviceAccountKey.json` from Firebase Console
   - Place it in the project root

4. **Start the bot:**
   ```bash
   npm start
   ```

## Project Structure

```
line-summary-bot/
├── functions/            # Firebase Cloud Functions (v2)
│   ├── index.js          # Webhook, Gemini Vision, Storage & API routes
│   ├── mcp-server.js     # Claude Model Context Protocol server (14 tools)
│   └── package.json      # Functions dependencies
├── index.js              # Local development server
├── package.json          # Workspace dependencies
├── .gitignore           # Git ignore rules
├── .env.example         # Environment variables template
└── README.md            # This file
```

## Security

- All sensitive data is stored in environment variables
- Firebase service account key is not committed to version control
- `.env` and `serviceAccountKey.json` are gitignored

## Support

For issues or questions, please create an issue in the GitHub repository.
