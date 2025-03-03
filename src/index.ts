#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import fs from 'fs-extra';
import path from 'path';
import natural from 'natural';

// Environment variables from MCP config
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR || path.join(process.cwd(), 'transcripts');

// Debug environment variables
console.error('Environment variables:');
console.error(`ZOOM_ACCOUNT_ID: ${ZOOM_ACCOUNT_ID ? 'Set' : 'Not set'}`);
console.error(`ZOOM_CLIENT_ID: ${ZOOM_CLIENT_ID ? 'Set' : 'Not set'}`);
console.error(`ZOOM_CLIENT_SECRET: ${ZOOM_CLIENT_SECRET ? 'Set' : 'Not set'}`);
console.error(`TRANSCRIPTS_DIR: ${TRANSCRIPTS_DIR}`);

// Validate required environment variables
if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
  throw new Error('Missing required environment variables: ZOOM_ACCOUNT_ID ZOOM_CLIENT_ID ZOOM_CLIENT_SECRET');
}

// Ensure transcripts directory exists
fs.ensureDirSync(TRANSCRIPTS_DIR);

// Tokenizer for natural language processing
const tokenizer = new natural.WordTokenizer();
const stemmer = natural.PorterStemmer;

// Types
interface ZoomToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  expires_at: number;
}

interface ZoomMeeting {
  id: string;
  uuid: string;
  topic: string;
  start_time: string;
  duration: number;
  total_size: number;
  recording_count: number;
  recording_files?: ZoomRecordingFile[];
}

interface ZoomRecording {
  id: string;
  meeting_id: string;
  recording_start: string;
  recording_end: string;
  file_type: string;
  file_size: number;
  play_url: string;
  download_url: string;
  status: string;
  recording_type: string;
}

interface ZoomRecordingFile {
  id: string;
  meeting_id: string;
  recording_start: string;
  recording_end: string;
  file_type: string;
  file_size: number;
  play_url: string;
  download_url: string;
  status: string;
  recording_type: string;
}

interface ZoomTranscript {
  id: string;
  meeting_id: string;
  recording_start: string;
  recording_end: string;
  file_type: string;
  file_size: number;
  play_url: string;
  download_url: string;
  status: string;
  recording_type: string;
}

interface DateRange {
  from?: string;
  to?: string;
}

interface TranscriptMetadata {
  id: string;
  meetingId: string;
  topic: string;
  startTime: string;
  duration: number;
  participants: string[];
  filePath: string;
}

// Zoom API Client
class ZoomClient {
  private token: ZoomToken | null = null;
  private axiosInstance: AxiosInstance;
  
  constructor(
    private accountId: string,
    private clientId: string,
    private clientSecret: string
  ) {
    this.axiosInstance = axios.create({
      baseURL: 'https://api.zoom.us/v2',
    });
    
    // Add request interceptor to handle token refresh
    this.axiosInstance.interceptors.request.use(async (config) => {
      // Ensure we have a valid token
      if (!this.token || this.isTokenExpired()) {
        await this.refreshToken();
      }
      
      // Add authorization header
      if (this.token) {
        config.headers.Authorization = `Bearer ${this.token.access_token}`;
      }
      
      return config;
    });
  }
  
  private isTokenExpired(): boolean {
    if (!this.token) return true;
    
    // Consider token expired if less than 5 minutes remaining
    const now = Date.now();
    return now >= this.token.expires_at - 5 * 60 * 1000;
  }
  
  private async refreshToken(): Promise<void> {
    try {
      const response = await axios.post(
        'https://zoom.us/oauth/token',
        null,
        {
          params: {
            grant_type: 'account_credentials',
            account_id: this.accountId,
          },
          auth: {
            username: this.clientId,
            password: this.clientSecret,
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
      
      this.token = {
        ...response.data,
        expires_at: Date.now() + response.data.expires_in * 1000,
      };
    } catch (error) {
      console.error('Failed to refresh Zoom token:', error);
      throw new Error('Failed to authenticate with Zoom API');
    }
  }
  
  async listRecordings(params: { from?: string; to?: string; page_size?: number; next_page_token?: string } = {}): Promise<any> {
    try {
      // Set default parameters if not provided
      const defaultParams = {
        page_size: params.page_size || 30,
        from: params.from || '2024-01-01',
        ...params
      };
      
      console.error('Attempting to list recordings with params:', defaultParams);
      console.error('Using account ID:', this.accountId);
      console.error('Using client ID:', this.clientId);
      
      const response = await this.axiosInstance.get('/users/me/recordings', { params: defaultParams });
      console.error('Recordings response received:', response.status);
      console.error('Total records:', response.data.total_records);
      console.error('Meetings count:', response.data.meetings?.length || 0);
      
      return response.data;
    } catch (error) {
      console.error('Failed to list recordings. Detailed error:', error);
      if (axios.isAxiosError(error)) {
        console.error('Response data:', error.response?.data);
        console.error('Response status:', error.response?.status);
      }
      throw new Error('Failed to list Zoom recordings');
    }
  }
  
  async getRecording(meetingId: string): Promise<any> {
    try {
      console.error(`Attempting to get recording for meeting ${meetingId}`);
      
      // First try to find the meeting in the list of recordings
      const recordings = await this.listRecordings({
        page_size: 30,
        from: '2024-01-01',
      });
      
      // Try to find the meeting by ID or UUID
      const meeting = recordings.meetings?.find((m: ZoomMeeting) => 
        m.id === meetingId || m.uuid === meetingId
      );
      
      if (meeting) {
        console.error(`Found meeting in recordings list: ${meeting.topic}`);
        return meeting;
      }
      
      // If not found in the list, try to get it directly
      console.error(`Meeting not found in recordings list, trying direct API call`);
      const response = await this.axiosInstance.get(`/meetings/${meetingId}/recordings`);
      console.error(`Direct API call successful`);
      return response.data;
    } catch (error) {
      console.error(`Failed to get recording for meeting ${meetingId}:`, error);
      if (axios.isAxiosError(error)) {
        console.error('Response data:', error.response?.data);
        console.error('Response status:', error.response?.status);
      }
      throw new Error(`Failed to get Zoom recording for meeting ${meetingId}`);
    }
  }
  
  async downloadTranscript(downloadUrl: string): Promise<string> {
    try {
      const response = await axios.get(downloadUrl, {
        headers: {
          Authorization: `Bearer ${this.token?.access_token}`,
        },
        responseType: 'text',
      });
      
      return response.data;
    } catch (error) {
      console.error('Failed to download transcript:', error);
      throw new Error('Failed to download Zoom transcript');
    }
  }
}

// File System Manager
class FileSystemManager {
  constructor(private baseDir: string) {
    fs.ensureDirSync(this.baseDir);
  }
  
  getMonthlyDir(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const monthDir = path.join(this.baseDir, `${year}-${month}`);
    
    fs.ensureDirSync(monthDir);
    fs.ensureDirSync(path.join(monthDir, 'metadata'));
    
    return monthDir;
  }
  
  formatFileName(meeting: ZoomMeeting): string {
    const startTime = new Date(meeting.start_time);
    const date = startTime.toISOString().split('T')[0];
    const time = startTime.toTimeString().split(' ')[0].replace(/:/g, '-');
    
    // Sanitize topic for filename
    const sanitizedTopic = meeting.topic
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    
    return `${date}_${time}_${sanitizedTopic}_${meeting.id}`;
  }
  
  async saveTranscript(meeting: ZoomMeeting, transcript: string, participants: string[] = []): Promise<string> {
    const monthDir = this.getMonthlyDir(new Date(meeting.start_time));
    const fileName = this.formatFileName(meeting);
    const filePath = path.join(monthDir, `${fileName}.vtt`);
    const metadataPath = path.join(monthDir, 'metadata', `${fileName}.json`);
    
    // Save transcript file
    await fs.writeFile(filePath, transcript);
    
    // Save metadata
    const metadata: TranscriptMetadata = {
      id: meeting.uuid,
      meetingId: meeting.id,
      topic: meeting.topic,
      startTime: meeting.start_time,
      duration: meeting.duration,
      participants,
      filePath,
    };
    
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });
    
    return filePath;
  }
  
  async listTranscripts(dateRange?: DateRange): Promise<TranscriptMetadata[]> {
    const transcripts: TranscriptMetadata[] = [];
    
    // Get all month directories
    const dirs = await fs.readdir(this.baseDir);
    
    for (const dir of dirs) {
      const monthDir = path.join(this.baseDir, dir);
      const metadataDir = path.join(monthDir, 'metadata');
      
      if (!(await fs.pathExists(metadataDir))) continue;
      
      const metadataFiles = await fs.readdir(metadataDir);
      
      for (const file of metadataFiles) {
        if (!file.endsWith('.json')) continue;
        
        const metadataPath = path.join(metadataDir, file);
        const metadata = await fs.readJson(metadataPath) as TranscriptMetadata;
        
        // Apply date range filter if provided
        if (dateRange) {
          const startTime = new Date(metadata.startTime).getTime();
          
          if (dateRange.from && startTime < new Date(dateRange.from).getTime()) {
            continue;
          }
          
          if (dateRange.to && startTime > new Date(dateRange.to).getTime()) {
            continue;
          }
        }
        
        transcripts.push(metadata);
      }
    }
    
    // Sort by start time (newest first)
    return transcripts.sort((a, b) => 
      new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  }
  
  async readTranscript(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }
  
  async searchTranscripts(query: string, dateRange?: DateRange): Promise<Array<{ metadata: TranscriptMetadata; matches: string[] }>> {
    const transcripts = await this.listTranscripts(dateRange);
    const results: Array<{ metadata: TranscriptMetadata; matches: string[] }> = [];
    
    // Tokenize and stem the query
    const queryTokens = tokenizer.tokenize(query.toLowerCase()) || [];
    const stemmedQueryTokens = queryTokens.map(token => stemmer.stem(token));
    
    for (const metadata of transcripts) {
      try {
        const content = await this.readTranscript(metadata.filePath);
        const lines = content.split('\n');
        const matches: string[] = [];
        
        // Process VTT file
        let currentText = '';
        let inCue = false;
        
        for (const line of lines) {
          if (line.includes('-->')) {
            inCue = true;
            currentText = '';
          } else if (line.trim() === '' && inCue) {
            inCue = false;
            
            // Check if current text matches query
            if (currentText.trim()) {
              const lineTokens = tokenizer.tokenize(currentText.toLowerCase()) || [];
              const stemmedLineTokens = lineTokens.map(token => stemmer.stem(token));
              
              // Check if all query tokens are in the line
              const allTokensFound = stemmedQueryTokens.every(queryToken => 
                stemmedLineTokens.some(lineToken => lineToken.includes(queryToken))
              );
              
              if (allTokensFound) {
                matches.push(currentText.trim());
              }
            }
          } else if (inCue) {
            currentText += ' ' + line;
          }
        }
        
        if (matches.length > 0) {
          results.push({ metadata, matches });
        }
      } catch (error) {
        console.error(`Error searching transcript ${metadata.filePath}:`, error);
      }
    }
    
    return results;
  }
}

// MCP Server Implementation
class ZoomTranscriptsServer {
  private server: Server;
  private zoomClient: ZoomClient;
  private fileManager: FileSystemManager;
  
  constructor() {
    this.server = new Server(
      {
        name: 'zoom-transcripts-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    
    this.zoomClient = new ZoomClient(
      ZOOM_ACCOUNT_ID!,
      ZOOM_CLIENT_ID!,
      ZOOM_CLIENT_SECRET!
    );
    
    this.fileManager = new FileSystemManager(TRANSCRIPTS_DIR);
    
    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }
  
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_recent_transcripts',
          description: 'Get and download transcripts from recent Zoom meetings',
          inputSchema: {
            type: 'object',
            properties: {
              count: {
                type: 'number',
                description: 'Number of recent meetings to fetch (default: 5)',
                minimum: 1,
                maximum: 30,
              },
            },
          },
        },
        {
          name: 'search_transcripts',
          description: 'Search across Zoom meeting transcripts for specific content',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              dateRange: {
                type: 'object',
                properties: {
                  from: {
                    type: 'string',
                    description: 'Start date (ISO format)',
                  },
                  to: {
                    type: 'string',
                    description: 'End date (ISO format)',
                  },
                },
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'download_transcript',
          description: 'Download a specific Zoom meeting transcript',
          inputSchema: {
            type: 'object',
            properties: {
              meetingId: {
                type: 'string',
                description: 'Zoom meeting ID',
              },
            },
            required: ['meetingId'],
          },
        },
        {
          name: 'list_meetings',
          description: 'List available Zoom meetings with recordings',
          inputSchema: {
            type: 'object',
            properties: {
              dateRange: {
                type: 'object',
                properties: {
                  from: {
                    type: 'string',
                    description: 'Start date (ISO format)',
                  },
                  to: {
                    type: 'string',
                    description: 'End date (ISO format)',
                  },
                },
              },
              participant: {
                type: 'string',
                description: 'Filter by participant name',
              },
            },
          },
        },
      ],
    }));
    
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'get_recent_transcripts':
            return await this.handleGetRecentTranscripts(request.params.arguments);
          case 'search_transcripts':
            return await this.handleSearchTranscripts(request.params.arguments);
          case 'download_transcript':
            return await this.handleDownloadTranscript(request.params.arguments);
          case 'list_meetings':
            return await this.handleListMeetings(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        console.error(`Error handling tool ${request.params.name}:`, error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }
  
  private async handleGetRecentTranscripts(args: any): Promise<any> {
    const count = args?.count || 5;
    
    // Get recordings list
    const recordings = await this.zoomClient.listRecordings({
      page_size: count,
    });
    
    // Check if there are any recordings
    if (!recordings.meetings || recordings.meetings.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No Zoom meetings with recordings found. You may not have any cloud recordings available.',
          },
        ],
      };
    }
    
    const results: string[] = [];
    
    // Process each meeting with recordings
    for (const meeting of recordings.meetings) {
      // Find transcript file
      const transcriptFile = meeting.recording_files?.find(
        (file: ZoomRecordingFile) => file.file_type === 'TRANSCRIPT'
      );
      
      if (!transcriptFile) {
        results.push(`No transcript available for meeting: ${meeting.topic} (${meeting.start_time})`);
        continue;
      }
      
      try {
        // Download transcript
        const transcript = await this.zoomClient.downloadTranscript(
          transcriptFile.download_url
        );
        
        // Extract participants from transcript
        const participants = this.extractParticipantsFromTranscript(transcript);
        
        // Save to file system
        const filePath = await this.fileManager.saveTranscript(
          meeting,
          transcript,
          participants
        );
        
        results.push(
          `Downloaded transcript for "${meeting.topic}" (${new Date(
            meeting.start_time
          ).toLocaleString()}) to ${filePath}`
        );
      } catch (error) {
        results.push(
          `Failed to download transcript for meeting: ${meeting.topic} (${meeting.start_time}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    
    return {
      content: [
        {
          type: 'text',
          text: results.join('\n\n'),
        },
      ],
    };
  }
  
  private async handleSearchTranscripts(args: any): Promise<any> {
    if (!args?.query) {
      throw new McpError(ErrorCode.InvalidParams, 'Query parameter is required');
    }
    
    const query = args.query;
    const dateRange = args.dateRange;
    
    // Search transcripts
    const results = await this.fileManager.searchTranscripts(query, dateRange);
    
    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No results found for query: "${query}"`,
          },
        ],
      };
    }
    
    // Format results
    const formattedResults = results.map(result => {
      const { metadata, matches } = result;
      const meetingDate = new Date(metadata.startTime).toLocaleString();
      
      return `Meeting: ${metadata.topic} (${meetingDate})\n` +
        `Matches:\n${matches.map(match => `- "${match}"`).join('\n')}`;
    }).join('\n\n');
    
    return {
      content: [
        {
          type: 'text',
          text: `Found ${results.length} meetings with matches for "${query}":\n\n${formattedResults}`,
        },
      ],
    };
  }
  
  private async handleDownloadTranscript(args: any): Promise<any> {
    if (!args?.meetingId) {
      throw new McpError(ErrorCode.InvalidParams, 'Meeting ID is required');
    }
    
    const meetingId = args.meetingId;
    
    try {
      // First try to get the meeting from the list of recordings
      const recordings = await this.zoomClient.listRecordings({
        page_size: 30,
        from: '2024-01-01',
      });
      
      console.error(`Looking for meeting ID ${meetingId} in ${recordings.meetings?.length || 0} meetings`);
      
      // Debug: Print all meeting IDs
      if (recordings.meetings && recordings.meetings.length > 0) {
        console.error('Available meeting IDs:');
        recordings.meetings.forEach((m: ZoomMeeting) => {
          console.error(`- ${m.id} (${m.topic})`);
        });
      }
      
      // Try to find the meeting by ID or UUID
      const meeting = recordings.meetings?.find((m: ZoomMeeting) => 
        m.id === meetingId || m.uuid === meetingId
      );
      
      if (!meeting) {
        return {
          content: [
            {
              type: 'text',
              text: `Meeting ID ${meetingId} not found in your recordings.`,
            },
          ],
        };
      }
      
      // Find transcript file
      const transcriptFile = meeting.recording_files?.find(
        (file: ZoomRecordingFile) => file.file_type === 'TRANSCRIPT'
      );
      
      if (!transcriptFile) {
        return {
          content: [
            {
              type: 'text',
              text: `No transcript available for meeting ID: ${meetingId}`,
            },
          ],
        };
      }
      
      // Download transcript
      const transcript = await this.zoomClient.downloadTranscript(
        transcriptFile.download_url
      );
      
      // Extract participants
      const participants = this.extractParticipantsFromTranscript(transcript);
      
      // Save to file system
      const filePath = await this.fileManager.saveTranscript(
        meeting,
        transcript,
        participants
      );
      
      return {
        content: [
          {
            type: 'text',
            text: `Downloaded transcript for "${meeting.topic}" (${new Date(
              meeting.start_time
            ).toLocaleString()}) to ${filePath}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to download transcript for meeting ID ${meetingId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  }
  
  private async handleListMeetings(args: any): Promise<any> {
    const dateRange = args?.dateRange;
    const participant = args?.participant?.toLowerCase();
    
    try {
      // Get recordings list
      const recordings = await this.zoomClient.listRecordings();
      
      // Check if meetings exist
      if (!recordings.meetings || recordings.meetings.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No Zoom meetings with recordings found. You may not have any cloud recordings available.',
            },
          ],
        };
      }
      
      // Filter by date range if provided
      let filteredMeetings = recordings.meetings;
      
      if (dateRange) {
        filteredMeetings = filteredMeetings.filter((meeting: ZoomMeeting) => {
          const meetingTime = new Date(meeting.start_time).getTime();
          
          if (dateRange.from && meetingTime < new Date(dateRange.from).getTime()) {
            return false;
          }
          
          if (dateRange.to && meetingTime > new Date(dateRange.to).getTime()) {
            return false;
          }
          
          return true;
        });
      }
      
      // If participant filter is provided, we need to check transcripts
      if (participant) {
        const meetingsWithParticipant: ZoomMeeting[] = [];
        
        for (const meeting of filteredMeetings) {
          // Check if we already have the transcript locally
          const transcripts = await this.fileManager.listTranscripts();
          const existingTranscript = transcripts.find(t => t.meetingId === meeting.id);
          
          if (existingTranscript) {
            // Check if participant is in the metadata
            if (existingTranscript.participants.some(p => 
              p.toLowerCase().includes(participant)
            )) {
              meetingsWithParticipant.push(meeting);
            }
          } else {
            // We don't have the transcript locally, so we need to check the recording
            try {
              const recording = await this.zoomClient.getRecording(meeting.id);
              const transcriptFile = recording.recording_files?.find(
                (file: ZoomRecordingFile) => file.file_type === 'TRANSCRIPT'
              );
              
              if (transcriptFile) {
                const transcript = await this.zoomClient.downloadTranscript(
                  transcriptFile.download_url
                );
                
                const participants = this.extractParticipantsFromTranscript(transcript);
                
                if (participants.some(p => p.toLowerCase().includes(participant))) {
                  meetingsWithParticipant.push(meeting);
                  
                  // Save the transcript while we're at it
                  await this.fileManager.saveTranscript(meeting, transcript, participants);
                }
              }
            } catch (error) {
              console.error(`Error checking transcript for meeting ${meeting.id}:`, error);
            }
          }
        }
        
        filteredMeetings = meetingsWithParticipant;
      }
      
      // Format results
      const formattedMeetings = filteredMeetings.map((meeting: ZoomMeeting) => {
        const startTime = new Date(meeting.start_time).toLocaleString();
        const duration = `${meeting.duration} minutes`;
        
        return `- ID: ${meeting.id}\n  UUID: ${meeting.uuid}\n  Topic: ${meeting.topic}\n  Date: ${startTime}\n  Duration: ${duration}\n  Recording Files: ${meeting.recording_files?.length || 0}`;
      }).join('\n\n');
      
      return {
        content: [
          {
            type: 'text',
            text: filteredMeetings.length > 0
              ? `Found ${filteredMeetings.length} meetings:\n\n${formattedMeetings}`
              : 'No meetings found matching the criteria.',
          },
        ],
      };
    } catch (error) {
      console.error('Error listing meetings:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error listing meetings: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
  
  private extractParticipantsFromTranscript(transcript: string): string[] {
    const participants = new Set<string>();
    const lines = transcript.split('\n');
    
    // Process VTT file to extract speaker names
    for (const line of lines) {
      // Look for speaker identification in format "<v Speaker Name>"
      const match = line.match(/<v ([^>]+)>/);
      if (match && match[1]) {
        participants.add(match[1].trim());
      }
    }
    
    return Array.from(participants);
  }
  
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Zoom Transcripts MCP server running on stdio');
  }
}

// Run the server
const server = new ZoomTranscriptsServer();
server.run().catch(console.error);
