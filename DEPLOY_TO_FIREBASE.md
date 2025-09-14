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

## Setup Firebase Configuration

Set the required environment variables using Firebase Functions config:

```bash
# LINE Bot Configuration
firebase functions:config:set line.channel_access_token="YOUR_LINE_CHANNEL_ACCESS_TOKEN"
firebase functions:config:set line.channel_secret="YOUR_LINE_CHANNEL_SECRET"

# Gemini AI Configuration
firebase functions:config:set gemini.api_key="YOUR_GEMINI_API_KEY"

# Google Sheets Configuration
firebase functions:config:set sheets.kla_download_code_url="YOUR_GOOGLE_SHEETS_URL"
firebase functions:config:set google.api_key="YOUR_GOOGLE_API_KEY"

# Firebase Configuration
firebase functions:config:set firebase.database_url="YOUR_FIREBASE_DATABASE_URL"
firebase functions:config:set firebase.project_id="YOUR_FIREBASE_PROJECT_ID"
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

## Environment Variables Migration

The following environment variables have been migrated to Firebase Functions config:

- `CHANNEL_ACCESS_TOKEN` → `line.channel_access_token`
- `CHANNEL_SECRET` → `line.channel_secret`
- `GEMINI_API_KEY` → `gemini.api_key`
- `KLA_DOWNLOAD_CODE_URL` → `sheets.kla_download_code_url`
- `GOOGLE_API_KEY` → `google.api_key`
- `FIREBASE_DATABASE_URL` → `firebase.database_url`
- `FIREBASE_PROJECT_ID` → `firebase.project_id`

## Benefits of Firebase Functions

1. **Serverless**: No server management required
2. **Auto-scaling**: Automatically scales based on demand
3. **Cost-effective**: Pay only for what you use
4. **Integrated**: Native integration with Firebase services
5. **Global**: Deploy to multiple regions for better performance
