#!/usr/bin/env node
import axios from 'axios';

// Zoom API credentials
const ACCOUNT_ID = 'youraccountidhere';
const CLIENT_ID = 'yourclientidhere';
const CLIENT_SECRET = 'yourclientsecrethere';

async function testZoomAPI() {
  try {
    console.log('Testing Zoom API with provided credentials...');
    
    // Get OAuth token
    console.log('Requesting OAuth token...');
    const tokenResponse = await axios.post(
      'https://zoom.us/oauth/token',
      null,
      {
        params: {
          grant_type: 'account_credentials',
          account_id: ACCOUNT_ID,
        },
        auth: {
          username: CLIENT_ID,
          password: CLIENT_SECRET,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    
    console.log('Token received successfully!');
    console.log('Token type:', tokenResponse.data.token_type);
    console.log('Expires in:', tokenResponse.data.expires_in, 'seconds');
    console.log('Scope:', tokenResponse.data.scope);
    
    // Use token to get user info
    console.log('\nFetching user info...');
    const userResponse = await axios.get(
      'https://api.zoom.us/v2/users/me',
      {
        headers: {
          Authorization: `Bearer ${tokenResponse.data.access_token}`,
        },
      }
    );
    
    console.log('User info retrieved successfully!');
    console.log('User ID:', userResponse.data.id);
    console.log('Email:', userResponse.data.email);
    console.log('Account ID:', userResponse.data.account_id);
    
    // Try to list recordings
    console.log('\nFetching recordings...');
    console.log('Token being used:', tokenResponse.data.access_token.substring(0, 10) + '...');
    
    // First, get user info to confirm which user we're authenticated as
    const userInfo = await axios.get(
      'https://api.zoom.us/v2/users/me',
      {
        headers: {
          Authorization: `Bearer ${tokenResponse.data.access_token}`,
        },
      }
    );
    console.log('Authenticated as user:', userInfo.data.email);
    console.log('User ID:', userInfo.data.id);
    
    // Now try to list recordings with more detailed parameters
    const recordingsResponse = await axios.get(
      'https://api.zoom.us/v2/users/me/recordings',
      {
        params: {
          page_size: 30,  // Increase page size to get more recordings
          from: '2024-01-01',  // Look back further in time
        },
        headers: {
          Authorization: `Bearer ${tokenResponse.data.access_token}`,
        },
      }
    );
    
    console.log('Recordings retrieved successfully!');
    console.log('Total records:', recordingsResponse.data.total_records);
    console.log('Meetings with recordings:', recordingsResponse.data.meetings?.length || 0);
    
    if (recordingsResponse.data.meetings?.length > 0) {
      console.log('\nFirst meeting details:');
      const meeting = recordingsResponse.data.meetings[0];
      console.log('Meeting ID:', meeting.id);
      console.log('Topic:', meeting.topic);
      console.log('Start time:', meeting.start_time);
      console.log('Recording files:', meeting.recording_files?.length || 0);
      
      // Check for transcript files
      const transcriptFiles = meeting.recording_files?.filter(file => file.file_type === 'TRANSCRIPT') || [];
      console.log('Transcript files:', transcriptFiles.length);
    } else {
      console.log('\nNo recordings found. This could be normal if you don\'t have any cloud recordings.');
    }
    
    console.log('\nAPI test completed successfully!');
  } catch (error) {
    console.error('Error testing Zoom API:');
    
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
      console.error('Response headers:', error.response.headers);
    } else if (error.request) {
      // The request was made but no response was received
      console.error('No response received:', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Error message:', error.message);
    }
  }
}

testZoomAPI();
