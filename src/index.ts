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

// Types and interfaces
interface SearchScope {
  local: {
    transcriptCount: number;
    dateRange: string;
  };
  cloud?: {
    availableCount: number;
    suggestedDownloads: number;
  };
}

interface SearchResponse {
  source: 'local' | 'cloud' | 'mixed' | 'none';
  searchScope: SearchScope;
  results: Array<{ metadata: TranscriptMetadata; matches: string[] }>;
  nextSteps?: {
    type: 'download_suggestion' | 'broaden_search' | 'refine_query';
    message: string;
    action?: {
      type: string;
      params: any;
    };
  };
}

interface ActionItem {
  text: string;
  speaker: string;
  target?: string;
  timestamp: string;
  meetingId: string;
  meetingTopic: string;
  confidence: number;
}

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
  
  async getTranscriptAvailability(): Promise<{ localCount: number; dateRangeText: string }> {
    const transcripts = await this.listTranscripts();
    
    if (transcripts.length === 0) {
      return { localCount: 0, dateRangeText: "No local transcripts available" };
    }
    
    // Get date range
    const startDates = transcripts.map(t => new Date(t.startTime));
    const oldestDate = new Date(Math.min(...startDates.map(d => d.getTime())));
    const newestDate = new Date(Math.max(...startDates.map(d => d.getTime())));
    
    const formatDate = (date: Date) => date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const dateRangeText = `${formatDate(oldestDate)} to ${formatDate(newestDate)}`;
    
    return { 
      localCount: transcripts.length,
      dateRangeText
    };
  }
  
  async searchTranscripts(query: string, dateRange?: DateRange): Promise<SearchResponse> {
    const transcripts = await this.listTranscripts(dateRange);
    const results: Array<{ metadata: TranscriptMetadata; matches: string[] }> = [];
    const availability = await this.getTranscriptAvailability();
    
    // Prepare search scope information
    const searchScope: SearchScope = {
      local: {
        transcriptCount: availability.localCount,
        dateRange: availability.dateRangeText
      }
    };
    
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
        let speaker = '';
        let timestamp = '';
        
        for (const line of lines) {
          // Capture timestamp
          if (line.includes('-->')) {
            inCue = true;
            currentText = '';
            timestamp = line.trim();
          } else if (line.trim() === '' && inCue) {
            inCue = false;
            
            // Check if current text matches query
            if (currentText.trim()) {
              const lineTokens = tokenizer.tokenize(currentText.toLowerCase()) || [];
              const stemmedLineTokens = lineTokens.map(token => stemmer.stem(token));
              
              // Enhanced matching with flexible token matching
              const matchScore = this.calculateMatchScore(stemmedQueryTokens, stemmedLineTokens);
              if (matchScore > 0.6) { // 60% match threshold
                matches.push(currentText.trim());
              }
            }
          } else if (inCue) {
            // Extract speaker if available
            const speakerMatch = line.match(/<v ([^>]+)>/);
            if (speakerMatch && speakerMatch[1]) {
              speaker = speakerMatch[1].trim();
            }
            
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
    
    // Prepare response with next steps if needed
    let nextSteps;
    if (results.length === 0) {
      nextSteps = {
        type: 'broaden_search' as const,
        message: 'No matching transcripts found locally. Consider broadening your search terms or checking cloud recordings.',
        action: {
          type: 'list_meetings',
          params: { dateRange }
        }
      };
    }
    
    return {
      source: results.length > 0 ? 'local' : 'none',
      searchScope,
      results,
      nextSteps
    };
  }
  
  // Helper method to calculate match score between query tokens and line tokens
  private calculateMatchScore(queryTokens: string[], lineTokens: string[]): number {
    if (queryTokens.length === 0) return 0;
    
    let matchCount = 0;
    for (const queryToken of queryTokens) {
      for (const lineToken of lineTokens) {
        // Check if line token includes the query token or vice versa
        if (lineToken.includes(queryToken) || queryToken.includes(lineToken)) {
          matchCount++;
          break;
        }
      }
    }
    
    return matchCount / queryTokens.length;
  }
  
  async extractActionItems(transcriptContent: string, metadata: TranscriptMetadata): Promise<ActionItem[]> {
    const actionItems: ActionItem[] = [];
    const lines = transcriptContent.split('\n');
    
    // Process VTT file to find action items
    let currentText = '';
    let currentTimestamp = '';
    let currentSpeaker = '';
    let inCue = false;
    
    // Action item indicator phrases
    const commitmentPhrases = [
      'i will', 'i\'ll', 'i can', 'let me', 'i should', 'i need to', 
      'i\'m going to', 'i am going to', 'i must', 'i have to',
      'send you', 'share with you', 'get back to you', 'follow up with', 
      'send it', 'email you', 'let you know'
    ];
    
    for (const line of lines) {
      if (line.includes('-->')) {
        // This is a timestamp line
        inCue = true;
        currentText = '';
        currentTimestamp = line.trim();
      } else if (line.trim() === '' && inCue) {
        // End of text cue
        inCue = false;
        const text = currentText.trim();
        
        if (text) {
          // Check if this looks like an action item
          const lowerText = text.toLowerCase();
          
          let isActionItem = false;
          let confidence = 0;
          
          // Check for commitment phrases
          for (const phrase of commitmentPhrases) {
            if (lowerText.includes(phrase)) {
              isActionItem = true;
              confidence += 0.2; // Increase confidence for each matching phrase
            }
          }
          
          // Additional heuristics to identify action items
          if (lowerText.includes('tomorrow') || 
              lowerText.includes('next week') || 
              lowerText.includes('later') ||
              lowerText.match(/by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)) {
            confidence += 0.2;
          }
          
          // Check if there's a target person
          let target = undefined;
          if (currentSpeaker && lowerText.match(/you|your/)) {
            // Trying to identify who "you" refers to
            const otherParticipants = metadata.participants.filter(p => p !== currentSpeaker);
            if (otherParticipants.length === 1) {
              target = otherParticipants[0];
              confidence += 0.1;
            }
          }
          
          if (isActionItem && confidence > 0.3) {
            actionItems.push({
              text,
              speaker: currentSpeaker,
              target,
              timestamp: currentTimestamp,
              meetingId: metadata.meetingId,
              meetingTopic: metadata.topic,
              confidence
            });
          }
        }
      } else if (inCue) {
        // Extract speaker if available
        const speakerMatch = line.match(/<v ([^>]+)>/);
        if (speakerMatch && speakerMatch[1]) {
          currentSpeaker = speakerMatch[1].trim();
        }
        
        currentText += ' ' + line;
      }
    }
    
    return actionItems;
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
    // Create comprehensive descriptions for the AI model to understand the workflow
    const toolsIntroduction = `
      ZOOM TRANSCRIPTS MCP WORKFLOW GUIDE:
      
      * ALWAYS check local transcripts first with 'check_local_transcripts' before searching or downloading
      * ONLY download transcripts when necessary and with user consent
      * Search locally before querying cloud APIs
      * Use specific IDs (meetingId or UUID) rather than full meeting titles when downloading
      
      RECOMMENDED SEQUENCE:
      1. check_local_transcripts - See what's available locally
      2. search_transcripts - Search through existing local transcripts
      3. list_meetings - Only if local search doesn't yield results
      4. download_transcript - Only with user consent
      5. extract_action_items - For finding commitments and tasks
    `;
    
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      toolsIntroduction,
      tools: [
        {
          name: 'get_recent_transcripts',
          description: 'Get and download transcripts from recent Zoom meetings. This tool will access the Zoom cloud API to fetch and download recent meeting transcripts.',
          bestPractices: 'Ask the user before downloading large amounts of transcripts',
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
          description: 'Search across Zoom meeting transcripts for specific content. This tool will search through locally stored transcripts first.',
          bestPractices: 'Try searching locally stored transcripts before requesting to download new ones from the cloud',
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
          name: 'extract_action_items',
          description: 'Identify and extract action items, tasks and commitments from meeting transcripts',
          bestPractices: 'Use this tool to find commitments, follow-ups, and tasks that were agreed to during meetings',
          inputSchema: {
            type: 'object',
            properties: {
              meetingId: {
                type: 'string',
                description: 'Meeting ID to extract action items from. Can be either the numeric ID or UUID.',
              },
              participant: {
                type: 'string', 
                description: 'Optional filter to only show action items from or assigned to a specific participant'
              }
            },
            required: ['meetingId'],
          },
        },
        {
          name: 'check_local_transcripts',
          description: 'Check what transcripts are already downloaded and available locally',
          bestPractices: 'Use this tool first to see what data is available before searching or downloading',
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
            },
          },
        },
        {
          name: 'download_transcript',
          description: 'Download a specific Zoom meeting transcript from the cloud to local storage',
          bestPractices: 'Ask the user before downloading transcripts unless specifically requested',
          inputSchema: {
            type: 'object',
            properties: {
              meetingId: {
                type: 'string',
                description: 'Zoom meeting ID or UUID',
              },
            },
            required: ['meetingId'],
          },
        },
        {
          name: 'list_meetings',
          description: 'List available Zoom meetings with recordings that exist in the cloud',
          bestPractices: 'Check local transcripts first before querying the cloud API',
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
          case 'extract_action_items':
            return await this.handleExtractActionItems(request.params.arguments);
          case 'check_local_transcripts':
            return await this.handleCheckLocalTranscripts(request.params.arguments);
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
    
    // Get availability information first
    const availability = await this.fileManager.getTranscriptAvailability();
    
    // Check for participant search patterns
    const isParticipantSearch = /(from|by|with)\s+([a-z\s]+)/i.test(query);
    let participantName = null;
    if (isParticipantSearch) {
      const match = query.match(/(from|by|with)\s+([a-z\s]+)/i);
      if (match && match[2]) {
        participantName = match[2].trim().toLowerCase();
      }
    }
    
    // Search transcripts
    const searchResponse = await this.fileManager.searchTranscripts(query, dateRange);
    
    // If no results found
    if (searchResponse.results.length === 0) {
      // Try to check if there are transcripts with the participant if it's a participant search
      let participantSuggestion = '';
      if (participantName) {
        const transcripts = await this.fileManager.listTranscripts();
        const meetingsWithParticipant = transcripts.filter(t => 
          t.participants.some(p => p.toLowerCase().includes(participantName!))
        );
        
        if (meetingsWithParticipant.length > 0) {
          participantSuggestion = `\n\nFound ${meetingsWithParticipant.length} meetings with participant "${participantName}":\n` +
            meetingsWithParticipant.slice(0, 5).map(t => 
              `- "${t.topic}" (${new Date(t.startTime).toLocaleString()})`
            ).join('\n');
            
          if (meetingsWithParticipant.length > 5) {
            participantSuggestion += `\n  ...and ${meetingsWithParticipant.length - 5} more`;
          }
          
          participantSuggestion += `\n\nTry searching with more specific terms about what was discussed.`;
        }
      }
      
      // Try to check cloud recordings if we have very few local recordings
      let cloudSuggestion = '';
      if (availability.localCount < 3) {
        try {
          const cloudRecordings = await this.zoomClient.listRecordings({
            page_size: 5,
            from: '2024-01-01',
          });
          
          if (cloudRecordings.meetings && cloudRecordings.meetings.length > 0) {
            cloudSuggestion = `\n\nThere are ${cloudRecordings.meetings.length}+ cloud recordings available. Consider using 'get_recent_transcripts' to download some for searching.`;
          }
        } catch (error) {
          console.error('Error checking cloud recordings:', error);
        }
      }
      
      // Check if we should suggest looking at cloud recordings
      if (searchResponse.nextSteps) {
        return {
          content: [
            {
              type: 'text',
              text: `🔍 No matches found for "${query}" in local transcripts.\n\n` +
                     `LOCAL TRANSCRIPT INFO:\n` +
                     `- Available: ${searchResponse.searchScope.local.transcriptCount} transcripts\n` +
                     `- Date range: ${searchResponse.searchScope.local.dateRange}\n\n` +
                     `SUGGESTIONS:\n` +
                     `- Try different search terms or fewer keywords\n` +
                     `- Check if you need to download more transcripts${participantSuggestion}${cloudSuggestion}`
            }
          ]
        };
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `No results found for query: "${query}"`
          }
        ]
      };
    }
    
    // Group results by relevance
    const highRelevanceResults = [];
    const mediumRelevanceResults = [];
    
    for (const result of searchResponse.results) {
      // Calculate relevance based on number of matches and how recent the meeting is
      const matchCount = result.matches.length;
      const meetingDate = new Date(result.metadata.startTime);
      const daysSinceNow = Math.floor((Date.now() - meetingDate.getTime()) / (1000 * 60 * 60 * 24));
      
      // Simple relevance scoring
      const isHighRelevance = matchCount > 5 || daysSinceNow < 30;
      
      if (isHighRelevance) {
        highRelevanceResults.push(result);
      } else {
        mediumRelevanceResults.push(result);
      }
    }
    
    // Format results by relevance groups
    let formattedResults = '';
    
    if (highRelevanceResults.length > 0) {
      formattedResults += `BEST MATCHES:\n\n`;
      formattedResults += highRelevanceResults.map(result => {
        const { metadata, matches } = result;
        const meetingDate = new Date(metadata.startTime).toLocaleString();
        const topMatches = matches.slice(0, 5);
        const hasMoreMatches = matches.length > 5;
        
        return `📝 Meeting: ${metadata.topic} (${meetingDate})\n` +
               `   ID: ${metadata.meetingId}\n` +
               `   Participants: ${metadata.participants.join(', ')}\n` +
               `   Matches (${matches.length}):\n${topMatches.map(match => `   - "${match}"`).join('\n')}` +
               (hasMoreMatches ? `\n   ...and ${matches.length - 5} more matches` : '');
      }).join('\n\n');
    }
    
    if (mediumRelevanceResults.length > 0) {
      if (formattedResults) formattedResults += '\n\n';
      formattedResults += `OTHER MATCHES:\n\n`;
      formattedResults += mediumRelevanceResults.map(result => {
        const { metadata, matches } = result;
        const meetingDate = new Date(metadata.startTime).toLocaleString();
        const topMatches = matches.slice(0, 3);
        const hasMoreMatches = matches.length > 3;
        
        return `📝 Meeting: ${metadata.topic} (${meetingDate})\n` +
               `   ID: ${metadata.meetingId}\n` +
               `   Matches (${matches.length}):\n${topMatches.map(match => `   - "${match}"`).join('\n')}` +
               (hasMoreMatches ? `\n   ...and ${matches.length - 3} more matches` : '');
      }).join('\n\n');
    }
    
    // See if we can find any action items related to the search
    let actionItemsText = '';
    try {
      let actionItems: ActionItem[] = [];
      // Check if the search is looking for action items or tasks
      const isActionItemSearch = query.toLowerCase().includes('action') || 
                                 query.toLowerCase().includes('task') || 
                                 query.toLowerCase().includes('todo') ||
                                 query.toLowerCase().includes('to do') ||
                                 query.toLowerCase().includes('follow up');
      
      if (isActionItemSearch) {
        for (const result of searchResponse.results) {
          const transcriptContent = await this.fileManager.readTranscript(result.metadata.filePath);
          const meetingActionItems = await this.fileManager.extractActionItems(transcriptContent, result.metadata);
          actionItems = [...actionItems, ...meetingActionItems];
        }
        
        if (actionItems.length > 0) {
          // Sort action items by confidence
          actionItems.sort((a, b) => b.confidence - a.confidence);
          
          actionItemsText = '\n\n🔔 DETECTED ACTION ITEMS:\n';
          
          // Group by meeting
          const itemsByMeeting: Record<string, ActionItem[]> = {};
          for (const item of actionItems) {
            if (!itemsByMeeting[item.meetingId]) {
              itemsByMeeting[item.meetingId] = [];
            }
            itemsByMeeting[item.meetingId].push(item);
          }
          
          // Format by meeting
          for (const [meetingId, items] of Object.entries(itemsByMeeting)) {
            const meeting = items[0].meetingTopic;
            actionItemsText += `\nFrom "${meeting}":\n`;
            
            for (const item of items) {
              const confidenceMarker = item.confidence > 0.7 ? '🔥' : (item.confidence > 0.5 ? '✓' : '❓');
              let actionText = `${confidenceMarker} ${item.speaker}: "${item.text.trim()}"`;
              if (item.target) {
                actionText += ` (assigned to: ${item.target})`;
              }
              actionItemsText += `${actionText}\n`;
            }
          }
          
          // Add a tip for getting more action items
          actionItemsText += `\nTip: Use 'extract_action_items' with a specific meeting ID for more detailed action items.`;
        }
      }
    } catch (error) {
      console.error('Error extracting action items:', error);
      // Continue without action items if there's an error
    }
    
    // Add summary section
    const summary = `🔍 SEARCH RESULTS FOR: "${query}"\n\n` +
                   `Found ${searchResponse.results.length} meetings with ${searchResponse.results.reduce((sum, r) => sum + r.matches.length, 0)} total matches.\n` +
                   `Local transcripts: ${searchResponse.searchScope.local.transcriptCount} available (${searchResponse.searchScope.local.dateRange})`;
    
    return {
      content: [
        {
          type: 'text',
          text: `${summary}\n\n${formattedResults}${actionItemsText}`
        }
      ]
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
  
  private async handleExtractActionItems(args: any): Promise<any> {
    if (!args?.meetingId) {
      throw new McpError(ErrorCode.InvalidParams, 'Meeting ID is required');
    }
    
    const meetingId = args.meetingId;
    const participantFilter = args.participant?.toLowerCase();
    
    try {
      // First check if we have the transcript locally - more flexible matching
      const transcripts = await this.fileManager.listTranscripts();
      
      // Try multiple matching strategies
      let existingTranscript = transcripts.find(t => 
        t.meetingId === meetingId || t.id === meetingId
      );
      
      // If not found directly, try to match by title or partial ID
      if (!existingTranscript) {
        existingTranscript = transcripts.find(t => 
          t.topic.includes(meetingId) || meetingId.includes(t.meetingId) || meetingId.includes(t.id)
        );
      }
      
      // If still not found, try using substring or fuzzy matching
      if (!existingTranscript && meetingId.length > 5) {
        existingTranscript = transcripts.find(t => 
          t.meetingId.includes(meetingId) || meetingId.includes(t.meetingId) ||
          t.id.includes(meetingId) || meetingId.includes(t.id) ||
          t.topic.toLowerCase().includes(meetingId.toLowerCase())
        );
      }
      
      if (existingTranscript) {
        // We have the transcript locally, extract action items
        const transcriptContent = await this.fileManager.readTranscript(existingTranscript.filePath);
        let actionItems = await this.fileManager.extractActionItems(transcriptContent, existingTranscript);
        
        // Apply participant filter if provided
        if (participantFilter) {
          actionItems = actionItems.filter(item => 
            item.speaker.toLowerCase().includes(participantFilter) || 
            (item.target && item.target.toLowerCase().includes(participantFilter))
          );
        }
        
        // Sort by confidence (highest first)
        actionItems.sort((a, b) => b.confidence - a.confidence);
        
        if (actionItems.length === 0) {
          // Suggest other meetings with the participant if filter applied
          if (participantFilter) {
            const meetingsWithParticipant = transcripts.filter(t => 
              t.participants.some(p => p.toLowerCase().includes(participantFilter))
            ).map(t => `- "${t.topic}" (${new Date(t.startTime).toLocaleString()}) - ID: ${t.meetingId}`);
            
            if (meetingsWithParticipant.length > 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No action items found in meeting "${existingTranscript.topic}" for participant "${participantFilter}".\n\nOther meetings with this participant:\n${meetingsWithParticipant.join('\n')}`
                  }
                ]
              };
            }
          }
          
          return {
            content: [
              {
                type: 'text',
                text: `No action items found in meeting "${existingTranscript.topic}" (${new Date(existingTranscript.startTime).toLocaleString()})${
                  participantFilter ? ` matching participant filter "${participantFilter}"` : ''
                }.`
              }
            ]
          };
        }
        
        // Group action items by speaker
        const actionItemsByOwner = new Map<string, ActionItem[]>();
        for (const item of actionItems) {
          const owner = item.target || item.speaker;
          if (!actionItemsByOwner.has(owner)) {
            actionItemsByOwner.set(owner, []);
          }
          actionItemsByOwner.get(owner)!.push(item);
        }
        
        // Format results
        let formattedOutput = `Found ${actionItems.length} action items in meeting "${existingTranscript.topic}" (${new Date(existingTranscript.startTime).toLocaleString()}):\n\n`;
        
        // Add meeting participants for context
        formattedOutput += `Meeting participants: ${existingTranscript.participants.join(', ')}\n\n`;
        
        // List action items grouped by owner
        for (const [owner, items] of actionItemsByOwner.entries()) {
          formattedOutput += `ITEMS FOR ${owner.toUpperCase()}:\n`;
          formattedOutput += items.map(item => {
            const confidenceMarker = item.confidence > 0.7 ? '🔥' : (item.confidence > 0.5 ? '✓' : '❓');
            let actionText = `${confidenceMarker} "${item.text.trim()}"`;
            if (item.speaker !== owner) {
              actionText += ` (from: ${item.speaker})`;
            }
            return actionText;
          }).join('\n');
          formattedOutput += '\n\n';
        }
        
        return {
          content: [
            {
              type: 'text',
              text: formattedOutput
            }
          ]
        };
      } else {
        // We don't have the transcript locally, check available transcripts
        const availability = await this.fileManager.getTranscriptAvailability();
        
        // Check if this ID might be in cloud recordings
        try {
          const cloudRecordings = await this.zoomClient.listRecordings({
            page_size: 30,
            from: '2024-01-01',
          });
          
          const matchingCloudMeeting = cloudRecordings.meetings?.find((m: ZoomMeeting) => 
            m.id === meetingId || 
            m.uuid === meetingId || 
            m.topic.includes(meetingId) || 
            meetingId.includes(m.topic)
          );
          
          if (matchingCloudMeeting) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Found meeting "${matchingCloudMeeting.topic}" in cloud recordings, but it needs to be downloaded first.\n\nPlease use this command to download it:\n\ndownload_transcript with meetingId: "${matchingCloudMeeting.id}"`
                }
              ]
            };
          }
        } catch (error) {
          console.error('Error checking cloud recordings:', error);
          // Continue with local-only suggestion
        }
        
        // List available transcripts for context
        const recentTranscripts = transcripts.slice(0, 5).map(t => 
          `- "${t.topic}" (${new Date(t.startTime).toLocaleString()}) - ID: ${t.meetingId}`
        );
        
        return {
          content: [
            {
              type: 'text',
              text: `Transcript for meeting ID "${meetingId}" not found locally.\n\nLocal transcript availability:\n- Count: ${availability.localCount}\n- Date range: ${availability.dateRangeText}\n\nRecent meetings available locally:\n${recentTranscripts.join('\n')}\n\nTo search for specific content, use search_transcripts with your query.`
            }
          ]
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error extracting action items: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
  
  private async handleCheckLocalTranscripts(args: any): Promise<any> {
    const dateRange = args?.dateRange;
    
    try {
      // Get local transcripts
      const transcripts = await this.fileManager.listTranscripts(dateRange);
      const availability = await this.fileManager.getTranscriptAvailability();
      
      // Try to check cloud recordings count for context
      let cloudInfo = '';
      try {
        const cloudRecordings = await this.zoomClient.listRecordings({
          page_size: 10,
          from: '2024-01-01',
        });
        
        if (cloudRecordings.meetings && cloudRecordings.meetings.length > 0) {
          cloudInfo = `\n\n🌥️ CLOUD AVAILABILITY:\n` +
                      `${cloudRecordings.meetings.length}+ transcripts available in Zoom Cloud`;
        }
      } catch (error) {
        console.error('Error checking cloud recordings:', error);
        // Continue without cloud info
      }
      
      // Create stats about participants
      const participantStats: Record<string, { count: number, meetingIds: string[] }> = {};
      for (const transcript of transcripts) {
        for (const participant of transcript.participants) {
          if (!participantStats[participant]) {
            participantStats[participant] = { count: 0, meetingIds: [] };
          }
          participantStats[participant].count++;
          participantStats[participant].meetingIds.push(transcript.meetingId);
        }
      }
      
      // Sort participants by frequency
      const topParticipants = Object.entries(participantStats)
        .sort(([, a], [, b]) => b.count - a.count)
        .slice(0, 10);
      
      if (transcripts.length === 0) {
        // Provide suggestions if no transcripts found
        let suggestions = '';
        
        if (dateRange) {
          suggestions = 'Try removing date filters or downloading transcripts from the cloud.';
        } else {
          suggestions = 'Use get_recent_transcripts to fetch recent meetings from the cloud.';
        }
        
        return {
          content: [
            {
              type: 'text',
              text: `📂 NO LOCAL TRANSCRIPTS FOUND\n\n` +
                    `${suggestions}${cloudInfo}`
            }
          ]
        };
      }
      
      // Group transcripts by month
      const transcriptsByMonth: Record<string, TranscriptMetadata[]> = {};
      
      for (const transcript of transcripts) {
        const date = new Date(transcript.startTime);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        if (!transcriptsByMonth[monthKey]) {
          transcriptsByMonth[monthKey] = [];
        }
        
        transcriptsByMonth[monthKey].push(transcript);
      }
      
      // Format results - Start with summary
      let output = `📂 LOCAL TRANSCRIPT SUMMARY\n\n` +
                   `AVAILABILITY:\n` + 
                   `- ${transcripts.length} transcripts locally\n` + 
                   `- Date range: ${availability.dateRangeText}\n` +
                   `- ${Object.keys(participantStats).length} unique participants\n`;
      
      // Add top participants if we have enough
      if (topParticipants.length > 3) {
        output += `\nMOST FREQUENT PARTICIPANTS:\n`;
        for (let i = 0; i < Math.min(5, topParticipants.length); i++) {
          const [name, stats] = topParticipants[i];
          output += `- ${name} (${stats.count} meetings)\n`;
        }
      }
                   
      // Add cloud info if available
      if (cloudInfo) {
        output += cloudInfo;
      }
      
      output += `\n\nTRANSCRIPT LISTING:\n`;
      
      // Sort months chronologically (newest first)
      const sortedMonths = Object.keys(transcriptsByMonth).sort().reverse();
      
      for (const month of sortedMonths) {
        const monthTranscripts = transcriptsByMonth[month];
        const [year, monthNum] = month.split('-');
        const monthName = new Date(parseInt(year), parseInt(monthNum) - 1, 1).toLocaleString('en-US', { month: 'long' });
        
        output += `\n${monthName} ${year} (${monthTranscripts.length} transcripts):\n`;
        
        // List first 5 transcripts for this month with participants
        for (let i = 0; i < Math.min(5, monthTranscripts.length); i++) {
          const t = monthTranscripts[i];
          output += `- ${t.topic} (${new Date(t.startTime).toLocaleString()})\n`;
          output += `  ID: ${t.meetingId} | Participants: ${t.participants.length > 3 ? 
            t.participants.slice(0, 3).join(', ') + ` +${t.participants.length - 3} more` : 
            t.participants.join(', ')}\n`;
        }
        
        // If there are more transcripts, show a count
        if (monthTranscripts.length > 5) {
          output += `  ...and ${monthTranscripts.length - 5} more meetings this month\n`;
        }
      }
      
      // Add usage tips
      output += `\n\nNEXT STEPS:\n` +
                `- To search transcripts: search_transcripts with query: "your search terms"\n` +
                `- To find action items: extract_action_items with meetingId: "meeting_id_here"\n` +
                `- To get more transcripts: get_recent_transcripts`;
      
      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error checking local transcripts: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
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
