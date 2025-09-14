# Deploy LINE Summary Bot to Firebase Functions

## Prerequisites

1. Install Firebase CLI:
```bash
npm install -g firebase-tools
```

2. Login to Firebase:
```bash
firebase login
```

3. Initialize Firebase project (if not already done):
```bash
firebase init
```

## Setup Environment Variables

Create a `.env` file in the `functions/` directory with your environment variables:

```bash
# Copy the example file
cp functions/.env.example functions/.env

# Edit the .env file with your actual values
```

The `.env` file should contain:
```bash
# LINE Bot Configuration
CHANNEL_ACCESS_TOKEN=your_line_channel_access_token_here
CHANNEL_SECRET=your_line_channel_secret_here

# Gemini AI Configuration
GEMINI_API_KEY=your_gemini_api_key_here

# Google Sheets Configuration
KLA_DOWNLOAD_CODE_URL=your_google_sheets_url_here
GOOGLE_API_KEY=your_google_api_key_here

# Firebase Configuration (optional - usually auto-detected)
FIREBASE_DATABASE_URL=your_firebase_database_url_here
```

## Deploy to Firebase

1. Install dependencies:
```bash
cd functions
npm install
```

2. Deploy the function:
```bash
firebase deploy --only functions
```

## Update LINE Webhook URL

After deployment, update your LINE Bot webhook URL to:
```
https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/lineSummaryBot/webhook
```

Replace `YOUR_PROJECT_ID` with your actual Firebase project ID.

## Local Development

To run locally for testing:
```bash
cd functions
npm run serve
```

The function will be available at:
```
http://localhost:5001/YOUR_PROJECT_ID/us-central1/lineSummaryBot
```

## Environment Variables

The bot uses the same environment variable names as before:

- `CHANNEL_ACCESS_TOKEN` - LINE Bot Channel Access Token
- `CHANNEL_SECRET` - LINE Bot Channel Secret
- `GEMINI_API_KEY` - Google Gemini API Key
- `KLA_DOWNLOAD_CODE_URL` - Google Sheets URL
- `GOOGLE_API_KEY` - Google API Key
- `FIREBASE_DATABASE_URL` - Firebase Database URL (optional)

## Benefits of Firebase Functions

1. **Serverless**: No server management required
2. **Auto-scaling**: Automatically scales based on demand
3. **Cost-effective**: Pay only for what you use
4. **Integrated**: Native integration with Firebase services
5. **Global**: Deploy to multiple regions for better performance
