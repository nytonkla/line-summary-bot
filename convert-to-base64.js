#!/usr/bin/env node

// Script to convert serviceAccountKey.json to base64
const fs = require('fs');
const path = require('path');

try {
  // Read the service account key file
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  const serviceAccountData = fs.readFileSync(serviceAccountPath, 'utf8');
  
  // Convert to base64
  const base64Key = Buffer.from(serviceAccountData).toString('base64');
  
  console.log('🔐 Base64 encoded service account key:');
  console.log('=====================================');
  console.log(base64Key);
  console.log('=====================================');
  console.log('');
  console.log('📋 Instructions:');
  console.log('1. Copy the base64 string above');
  console.log('2. In Render dashboard, add environment variable:');
  console.log('   Key: FIREBASE_SERVICE_ACCOUNT_KEY');
  console.log('   Value: [paste the base64 string]');
  console.log('3. Delete the serviceAccountKey.json file for security');
  console.log('');
  console.log('✅ Your bot will now use the base64 encoded key from environment variables!');
  
} catch (error) {
  console.error('❌ Error:', error.message);
  console.log('');
  console.log('Make sure serviceAccountKey.json exists in the current directory.');
}
