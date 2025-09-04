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

## Deployment on Render

### Prerequisites

1. GitHub repository with your code
2. LINE Bot channel with webhook URL
3. Firebase project with Firestore enabled
4. Google AI Studio API key

### Steps to Deploy

1. **Fork/Clone this repository** to your GitHub account

2. **Create a new Web Service on Render:**
   - Go to [Render Dashboard](https://dashboard.render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Choose the repository: `line-summary-bot`

3. **Configure the service:**
   - **Name**: `line-summary-bot`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (or upgrade as needed)

4. **Set Environment Variables:**
   Add these environment variables in Render dashboard:
   ```
   CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
   CHANNEL_SECRET=your_line_channel_secret
   GEMINI_API_KEY=your_gemini_api_key
   FIREBASE_PROJECT_ID=your_firebase_project_id
   FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com
   ```

5. **Upload Firebase Service Account Key:**
   - In Render dashboard, go to your service
   - Navigate to "Environment" tab
   - Upload your `serviceAccountKey.json` file
   - Or set the content as an environment variable

6. **Deploy:**
   - Click "Create Web Service"
   - Wait for deployment to complete
   - Note the provided URL (e.g., `https://your-app.onrender.com`)

7. **Configure LINE Webhook:**
   - Go to LINE Developers Console
   - Set webhook URL to: `https://your-app.onrender.com/webhook`
   - Enable webhook

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
├── index.js              # Main bot application
├── package.json          # Dependencies and scripts
├── render.yaml           # Render deployment configuration
├── Dockerfile            # Docker configuration
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
