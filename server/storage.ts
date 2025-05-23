import { 
  users, type User, type InsertUser, 
  contacts, type Contact, type InsertContact, 
  campaigns, type Campaign, type InsertCampaign, 
  analytics, type Analytics, type InsertAnalytics,
  settings, type Settings, type InsertSettings
} from "@shared/schema";
import session from "express-session";
import createMemoryStore from "memorystore";
import connectPgSimple from "connect-pg-simple";
import { db } from "./db";
import { eq, and, like, gte, or, desc } from "drizzle-orm";
import { pool } from "./db";
import crypto from 'crypto';
import { DB_CONFIG } from './config';

// Define the SessionStore type to handle type errors
declare module "express-session" {
  interface SessionData {
    passport?: any;
  }
}

const MemoryStore = createMemoryStore(session);
const PostgresStore = connectPgSimple(session);

// Define the storage interface
export interface IStorage {
  // Session store
  sessionStore: session.Store;
  
  // User methods
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  createResetToken(userId: number): Promise<string>;
  verifyResetToken(token: string): Promise<User | undefined>;
  updatePassword(userId: number, password: string): Promise<boolean>;
  
  // Contact methods
  getContacts(accountId: number, filters?: ContactFilters): Promise<Contact[]>;
  getContactById(id: number): Promise<Contact | undefined>;
  getContactByMobile(mobile: string, accountId: number): Promise<Contact | undefined>;
  createContact(contact: InsertContact): Promise<Contact>;
  updateContact(id: number, contact: Partial<InsertContact>): Promise<Contact | undefined>;
  deleteContact(id: number): Promise<boolean>;
  importContacts(contacts: InsertContact[], deduplicateByMobile: boolean): Promise<{ imported: number, duplicates: number }>;
  
  // Campaign methods
  getCampaigns(accountId: number, filters?: CampaignFilters): Promise<Campaign[]>;
  getCampaignById(id: number): Promise<Campaign | undefined>;
  createCampaign(campaign: InsertCampaign): Promise<Campaign>;
  updateCampaign(id: number, campaign: Partial<InsertCampaign>): Promise<Campaign | undefined>;
  deleteCampaign(id: number): Promise<boolean>;
  launchCampaign(id: number): Promise<boolean>;
  
  // Analytics methods
  getAnalytics(accountId: number, campaignId?: number): Promise<Analytics[]>;
  createOrUpdateAnalytics(analytics: InsertAnalytics): Promise<Analytics>;
  
  // Settings methods
  getSettings(accountId: number): Promise<Settings | undefined>;
  updateSettings(accountId: number, settings: Partial<InsertSettings>): Promise<Settings>;
}

// Filter types
export interface ContactFilters {
  search?: string;
  label?: string;
  location?: string;
  dateRange?: string;
}

export interface CampaignFilters {
  search?: string;
  status?: string;
  dateRange?: string;
}

// Database storage implementation
export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    try {
      // Log database connection info
      console.log('Initializing PostgreSQL session store');
      
      // Enhanced session store configuration
      this.sessionStore = new PostgresStore({ 
        pool,
        createTableIfMissing: true, // Automatically create the session table if it doesn't exist
        tableName: 'session', // Match the existing table name in our scripts
        schemaName: 'public', 
        pruneSessionInterval: 60 * 15, // Prune expired sessions every 15 minutes
        errorLog: (error) => console.error('PostgreSQL session store error:', error)
      });
      
      console.log('PostgreSQL session store successfully initialized');
    } catch (error) {
      console.error('CRITICAL ERROR initializing PostgreSQL session store:', error);
      // Fallback to memory store in case of database connection issues
      console.warn('Falling back to memory session store (sessions will not persist)');
      this.sessionStore = new MemoryStore({
        checkPeriod: 86400000 // Prune expired entries every day
      });
    }
  }

  // USER METHODS
  async getUser(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result.length > 0 ? result[0] : undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result.length > 0 ? result[0] : undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email));
    return result.length > 0 ? result[0] : undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db
      .insert(users)
      .values({ ...insertUser, createdAt: new Date() })
      .returning();
    return result[0];
  }
  
  async createResetToken(userId: number): Promise<string> {
    const user = await this.getUser(userId);
    if (!user) throw new Error('User not found');
    
    // Generate random token
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex');
    
    // Set token expiry to 1 hour from now
    const expiry = new Date();
    expiry.setHours(expiry.getHours() + 1);
    
    // Update user with new token
    const result = await db
      .update(users)
      .set({ 
        resetToken: token, 
        resetTokenExpiry: expiry 
      })
      .where(eq(users.id, userId))
      .returning();
    
    if (result.length === 0) throw new Error('Failed to create reset token');
    
    return token;
  }
  
  async verifyResetToken(token: string): Promise<User | undefined> {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.resetToken, token));
    
    if (result.length === 0) return undefined;
    
    const user = result[0];
    
    // Check if token is expired
    if (!user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
      return undefined;
    }
    
    return user;
  }
  
  async updatePassword(userId: number, password: string): Promise<boolean> {
    const result = await db
      .update(users)
      .set({ 
        password,
        resetToken: null,
        resetTokenExpiry: null
      })
      .where(eq(users.id, userId))
      .returning();
    
    return result.length > 0;
  }

  // CONTACT METHODS
  async getContacts(accountId: number, filters?: ContactFilters): Promise<Contact[]> {
    let query = db.select().from(contacts).where(eq(contacts.accountId, accountId));
    
    if (filters) {
      if (filters.search) {
        const searchTerm = `%${filters.search}%`;
        // Apply search filters
        const searchResults = await db.select().from(contacts)
          .where(
            and(
              eq(contacts.accountId, accountId),
              or(
                like(contacts.name, searchTerm),
                like(contacts.mobile, searchTerm)
              )
            )
          );
        return searchResults;
      }
      
      if (filters.label) {
        // Apply label filter
        const labelResults = await db.select().from(contacts)
          .where(
            and(
              eq(contacts.accountId, accountId),
              eq(contacts.label, filters.label)
            )
          );
        return labelResults;
      }
      
      if (filters.location) {
        // Apply location filter
        const locationResults = await db.select().from(contacts)
          .where(
            and(
              eq(contacts.accountId, accountId),
              eq(contacts.location, filters.location)
            )
          );
        return locationResults;
      }
      
      if (filters.dateRange) {
        const now = new Date();
        let startDate = new Date();
        
        switch (filters.dateRange) {
          case 'today':
            startDate.setHours(0, 0, 0, 0);
            break;
          case 'last-week':
            startDate.setDate(now.getDate() - 7);
            break;
          case 'last-month':
            startDate.setMonth(now.getMonth() - 1);
            break;
          case 'last-year':
            startDate.setFullYear(now.getFullYear() - 1);
            break;
        }
        
        // Apply date range filter
        const dateResults = await db.select().from(contacts)
          .where(
            and(
              eq(contacts.accountId, accountId),
              gte(contacts.createdAt, startDate)
            )
          );
        return dateResults;
      }
    }
    
    // Default query with no filters
    const results = await query;
    return results;
  }

  async getContactById(id: number): Promise<Contact | undefined> {
    const result = await db.select().from(contacts).where(eq(contacts.id, id));
    return result.length > 0 ? result[0] : undefined;
  }

  async getContactByMobile(mobile: string, accountId: number): Promise<Contact | undefined> {
    const result = await db.select()
      .from(contacts)
      .where(
        and(
          eq(contacts.mobile, mobile),
          eq(contacts.accountId, accountId)
        )
      );
    return result.length > 0 ? result[0] : undefined;
  }

  async createContact(insertContact: InsertContact): Promise<Contact> {
    const result = await db
      .insert(contacts)
      .values({ 
        ...insertContact, 
        location: insertContact.location || null,
        label: insertContact.label || null,
        createdAt: new Date() 
      })
      .returning();
    return result[0];
  }

  async updateContact(id: number, updateData: Partial<InsertContact>): Promise<Contact | undefined> {
    const result = await db
      .update(contacts)
      .set(updateData)
      .where(eq(contacts.id, id))
      .returning();
    return result.length > 0 ? result[0] : undefined;
  }

  async deleteContact(id: number): Promise<boolean> {
    const result = await db.delete(contacts).where(eq(contacts.id, id)).returning();
    return result.length > 0;
  }

  async importContacts(contactsList: InsertContact[], deduplicateByMobile: boolean): Promise<{ imported: number, duplicates: number }> {
    let imported = 0;
    let duplicates = 0;
    
    for (const contact of contactsList) {
      if (deduplicateByMobile) {
        const existing = await this.getContactByMobile(contact.mobile, contact.accountId);
        if (existing) {
          duplicates++;
          continue;
        }
      }
      
      await this.createContact(contact);
      imported++;
    }
    
    return { imported, duplicates };
  }

  // CAMPAIGN METHODS
  async getCampaigns(accountId: number, filters?: CampaignFilters): Promise<Campaign[]> {
    let query = db.select().from(campaigns).where(eq(campaigns.accountId, accountId));
    
    if (filters) {
      if (filters.search) {
        const searchTerm = `%${filters.search}%`;
        // Apply search filters
        const searchResults = await db.select().from(campaigns)
          .where(
            and(
              eq(campaigns.accountId, accountId),
              like(campaigns.name, searchTerm)
            )
          );
        return searchResults;
      }
      
      if (filters.status) {
        // Apply status filter
        const statusResults = await db.select().from(campaigns)
          .where(
            and(
              eq(campaigns.accountId, accountId),
              eq(campaigns.status, filters.status)
            )
          );
        return statusResults;
      }
      
      if (filters.dateRange) {
        const now = new Date();
        let startDate = new Date();
        
        switch (filters.dateRange) {
          case 'today':
            startDate.setHours(0, 0, 0, 0);
            break;
          case 'last-week':
            startDate.setDate(now.getDate() - 7);
            break;
          case 'last-month':
            startDate.setMonth(now.getMonth() - 1);
            break;
          case 'last-year':
            startDate.setFullYear(now.getFullYear() - 1);
            break;
        }
        
        // Apply date range filter
        const dateResults = await db.select().from(campaigns)
          .where(
            and(
              eq(campaigns.accountId, accountId),
              gte(campaigns.createdAt, startDate)
            )
          );
        return dateResults;
      }
    }
    
    // Default query with no filters
    const results = await query;
    return results;
  }

  async getCampaignById(id: number): Promise<Campaign | undefined> {
    const result = await db.select().from(campaigns).where(eq(campaigns.id, id));
    return result.length > 0 ? result[0] : undefined;
  }

  async createCampaign(insertCampaign: InsertCampaign): Promise<Campaign> {
    const result = await db
      .insert(campaigns)
      .values({ 
        ...insertCampaign, 
        contactLabel: insertCampaign.contactLabel || null,
        status: "draft", 
        createdAt: new Date() 
      })
      .returning();
    return result[0];
  }

  async updateCampaign(id: number, updateData: Partial<InsertCampaign>): Promise<Campaign | undefined> {
    const result = await db
      .update(campaigns)
      .set(updateData)
      .where(eq(campaigns.id, id))
      .returning();
    return result.length > 0 ? result[0] : undefined;
  }

  async deleteCampaign(id: number): Promise<boolean> {
    const result = await db.delete(campaigns).where(eq(campaigns.id, id)).returning();
    return result.length > 0;
  }
  
  async launchCampaign(id: number): Promise<boolean> {
    const result = await db
      .update(campaigns)
      .set({ status: "active" })
      .where(eq(campaigns.id, id))
      .returning();
    
    if (result.length === 0) return false;
    
    // Create initial analytics entry
    await this.createOrUpdateAnalytics({
      campaignId: id,
      sent: 0,
      delivered: 0,
      read: 0,
      optout: 0,
      hold: 0,
      failed: 0,
      accountId: result[0].accountId
    });
    
    return true;
  }

  // ANALYTICS METHODS
  async getAnalytics(accountId: number, campaignId?: number): Promise<Analytics[]> {
    if (campaignId) {
      const result = await db.select().from(analytics)
        .where(
          and(
            eq(analytics.accountId, accountId),
            eq(analytics.campaignId, campaignId)
          )
        );
      return result;
    }
    
    const result = await db.select().from(analytics)
      .where(eq(analytics.accountId, accountId));
    return result;
  }

  async createOrUpdateAnalytics(insertAnalytics: InsertAnalytics): Promise<Analytics> {
    // Check if we already have analytics for this campaign
    const existing = await db
      .select()
      .from(analytics)
      .where(eq(analytics.campaignId, insertAnalytics.campaignId));
    
    if (existing.length > 0) {
      // Update existing analytics
      const result = await db
        .update(analytics)
        .set({ 
          ...insertAnalytics,
          updatedAt: new Date(),
          sent: insertAnalytics.sent ?? existing[0].sent,
          delivered: insertAnalytics.delivered ?? existing[0].delivered,
          read: insertAnalytics.read ?? existing[0].read,
          optout: insertAnalytics.optout ?? existing[0].optout,
          hold: insertAnalytics.hold ?? existing[0].hold,
          failed: insertAnalytics.failed ?? existing[0].failed
        })
        .where(eq(analytics.id, existing[0].id))
        .returning();
      return result[0];
    }
    
    // Create new analytics
    const result = await db
      .insert(analytics)
      .values({ 
        ...insertAnalytics, 
        updatedAt: new Date(),
        sent: insertAnalytics.sent || 0,
        delivered: insertAnalytics.delivered || 0,
        read: insertAnalytics.read || 0,
        optout: insertAnalytics.optout || 0,
        hold: insertAnalytics.hold || 0,
        failed: insertAnalytics.failed || 0
      })
      .returning();
    return result[0];
  }
  
  // SETTINGS METHODS
  async getSettings(accountId: number): Promise<Settings | undefined> {
    const result = await db
      .select()
      .from(settings)
      .where(eq(settings.accountId, accountId));
    
    return result.length > 0 ? result[0] : undefined;
  }
  
  async updateSettings(accountId: number, settingsData: Partial<InsertSettings>): Promise<Settings> {
    // Check if settings already exist for this account
    const existing = await this.getSettings(accountId);
    
    if (existing) {
      // Update existing settings
      const result = await db
        .update(settings)
        .set({ 
          ...settingsData,
          updatedAt: new Date()
        })
        .where(eq(settings.id, existing.id))
        .returning();
      return result[0];
    }
    
    // Create new settings
    const result = await db
      .insert(settings)
      .values({ 
        ...settingsData,
        accountId,
        updatedAt: new Date()
      })
      .returning();
    return result[0];
  }
}

// In-memory storage implementation for local development
export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private contacts: Map<number, Contact>;
  private campaigns: Map<number, Campaign>;
  private analyticsData: Map<number, Analytics>;
  private settingsData: Map<number, Settings>;
  sessionStore: session.Store;
  
  private userCurrentId: number;
  private contactCurrentId: number;
  private campaignCurrentId: number;
  private analyticsCurrentId: number;
  private settingsCurrentId: number;

  constructor() {
    this.users = new Map();
    this.contacts = new Map();
    this.campaigns = new Map();
    this.analyticsData = new Map();
    this.settingsData = new Map();
    
    this.userCurrentId = 1;
    this.contactCurrentId = 1;
    this.campaignCurrentId = 1;
    this.analyticsCurrentId = 1;
    this.settingsCurrentId = 1;
    
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000, // 24h
    });
  }

  // USER METHODS
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }
  
  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.email === email,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.userCurrentId++;
    const createdAt = new Date();
    const user: User = { 
      ...insertUser, 
      id, 
      createdAt,
      email: insertUser.email || null,
      resetToken: null, 
      resetTokenExpiry: null 
    };
    this.users.set(id, user);
    return user;
  }
  
  async createResetToken(userId: number): Promise<string> {
    const user = await this.getUser(userId);
    if (!user) throw new Error('User not found');
    
    // Generate random token
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex');
    
    // Set token expiry to 1 hour from now
    const expiry = new Date();
    expiry.setHours(expiry.getHours() + 1);
    
    // Update user with new token
    const updatedUser = { 
      ...user, 
      resetToken: token, 
      resetTokenExpiry: expiry 
    };
    this.users.set(userId, updatedUser);
    
    return token;
  }
  
  async verifyResetToken(token: string): Promise<User | undefined> {
    const user = Array.from(this.users.values()).find(
      (user) => user.resetToken === token
    );
    
    if (!user) return undefined;
    
    // Check if token is expired
    if (!user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
      return undefined;
    }
    
    return user;
  }
  
  async updatePassword(userId: number, password: string): Promise<boolean> {
    const user = await this.getUser(userId);
    if (!user) return false;
    
    // Update user with new password and clear token
    const updatedUser = { 
      ...user, 
      password,
      resetToken: null,
      resetTokenExpiry: null
    };
    this.users.set(userId, updatedUser);
    
    return true;
  }

  // CONTACT METHODS
  async getContacts(accountId: number, filters?: ContactFilters): Promise<Contact[]> {
    let contacts = Array.from(this.contacts.values()).filter(
      (contact) => contact.accountId === accountId
    );
    
    if (filters) {
      if (filters.search) {
        const searchTerm = filters.search.toLowerCase();
        contacts = contacts.filter(contact => 
          contact.name.toLowerCase().includes(searchTerm) || 
          contact.mobile.toLowerCase().includes(searchTerm)
        );
      }
      
      if (filters.label) {
        contacts = contacts.filter(contact => contact.label === filters.label);
      }
      
      if (filters.location) {
        contacts = contacts.filter(contact => contact.location === filters.location);
      }
      
      if (filters.dateRange) {
        const now = new Date();
        let startDate = new Date();
        
        switch (filters.dateRange) {
          case 'today':
            startDate.setHours(0, 0, 0, 0);
            break;
          case 'last-week':
            startDate.setDate(now.getDate() - 7);
            break;
          case 'last-month':
            startDate.setMonth(now.getMonth() - 1);
            break;
          case 'last-year':
            startDate.setFullYear(now.getFullYear() - 1);
            break;
        }
        
        contacts = contacts.filter(contact => 
          new Date(contact.createdAt) >= startDate
        );
      }
    }
    
    return contacts;
  }

  async getContactById(id: number): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }

  async getContactByMobile(mobile: string, accountId: number): Promise<Contact | undefined> {
    return Array.from(this.contacts.values()).find(
      (contact) => contact.mobile === mobile && contact.accountId === accountId
    );
  }

  async createContact(insertContact: InsertContact): Promise<Contact> {
    const id = this.contactCurrentId++;
    const createdAt = new Date();
    const contact: Contact = { 
      ...insertContact, 
      id, 
      createdAt,
      location: insertContact.location || null,
      label: insertContact.label || null
    };
    this.contacts.set(id, contact);
    return contact;
  }

  async updateContact(id: number, updateData: Partial<InsertContact>): Promise<Contact | undefined> {
    const contact = this.contacts.get(id);
    if (!contact) return undefined;
    
    const updatedContact = { ...contact, ...updateData };
    this.contacts.set(id, updatedContact);
    return updatedContact;
  }

  async deleteContact(id: number): Promise<boolean> {
    return this.contacts.delete(id);
  }

  async importContacts(contacts: InsertContact[], deduplicateByMobile: boolean): Promise<{ imported: number, duplicates: number }> {
    let imported = 0;
    let duplicates = 0;
    
    for (const contact of contacts) {
      if (deduplicateByMobile) {
        const existing = await this.getContactByMobile(contact.mobile, contact.accountId);
        if (existing) {
          duplicates++;
          continue;
        }
      }
      
      await this.createContact(contact);
      imported++;
    }
    
    return { imported, duplicates };
  }

  // CAMPAIGN METHODS
  async getCampaigns(accountId: number, filters?: CampaignFilters): Promise<Campaign[]> {
    let campaigns = Array.from(this.campaigns.values()).filter(
      (campaign) => campaign.accountId === accountId
    );
    
    if (filters) {
      if (filters.search) {
        const searchTerm = filters.search.toLowerCase();
        campaigns = campaigns.filter(campaign => 
          campaign.name.toLowerCase().includes(searchTerm)
        );
      }
      
      if (filters.status) {
        campaigns = campaigns.filter(campaign => campaign.status === filters.status);
      }
      
      if (filters.dateRange) {
        const now = new Date();
        let startDate = new Date();
        
        switch (filters.dateRange) {
          case 'today':
            startDate.setHours(0, 0, 0, 0);
            break;
          case 'last-week':
            startDate.setDate(now.getDate() - 7);
            break;
          case 'last-month':
            startDate.setMonth(now.getMonth() - 1);
            break;
          case 'last-year':
            startDate.setFullYear(now.getFullYear() - 1);
            break;
        }
        
        campaigns = campaigns.filter(campaign => 
          new Date(campaign.createdAt) >= startDate
        );
      }
    }
    
    return campaigns;
  }

  async getCampaignById(id: number): Promise<Campaign | undefined> {
    return this.campaigns.get(id);
  }

  async createCampaign(insertCampaign: InsertCampaign): Promise<Campaign> {
    const id = this.campaignCurrentId++;
    const createdAt = new Date();
    
    // Create the campaign object with explicit properties to avoid type issues
    const campaign: Campaign = { 
      id,
      name: insertCampaign.name,
      template: insertCampaign.template,
      contactLabel: insertCampaign.contactLabel || null,
      status: "draft",
      scheduledFor: insertCampaign.scheduledFor || null,
      accountId: insertCampaign.accountId,
      createdAt
    };
    
    this.campaigns.set(id, campaign);
    return campaign;
  }

  async updateCampaign(id: number, updateData: Partial<InsertCampaign>): Promise<Campaign | undefined> {
    const campaign = this.campaigns.get(id);
    if (!campaign) return undefined;
    
    // Create a proper updated campaign with explicit handling of scheduledFor
    const updatedCampaign: Campaign = { 
      ...campaign,
      name: updateData.name ?? campaign.name,
      template: updateData.template ?? campaign.template,
      contactLabel: updateData.contactLabel !== undefined ? updateData.contactLabel || null : campaign.contactLabel,
      scheduledFor: updateData.scheduledFor !== undefined ? updateData.scheduledFor || null : campaign.scheduledFor
    };
    
    this.campaigns.set(id, updatedCampaign);
    return updatedCampaign;
  }

  async deleteCampaign(id: number): Promise<boolean> {
    return this.campaigns.delete(id);
  }
  
  async launchCampaign(id: number): Promise<boolean> {
    const campaign = this.campaigns.get(id);
    if (!campaign) return false;
    
    const updatedCampaign = { ...campaign, status: "active" };
    this.campaigns.set(id, updatedCampaign);
    
    // Create initial analytics entry with default zero values
    await this.createOrUpdateAnalytics({
      campaignId: id,
      sent: 0,
      delivered: 0,
      read: 0,
      optout: 0,
      hold: 0,
      failed: 0,
      accountId: campaign.accountId
    });
    
    return true;
  }

  // ANALYTICS METHODS
  async getAnalytics(accountId: number, campaignId?: number): Promise<Analytics[]> {
    let analytics = Array.from(this.analyticsData.values()).filter(
      (analytics) => analytics.accountId === accountId
    );
    
    if (campaignId) {
      analytics = analytics.filter(a => a.campaignId === campaignId);
    }
    
    return analytics;
  }

  async createOrUpdateAnalytics(insertAnalytics: InsertAnalytics): Promise<Analytics> {
    // Check if we already have analytics for this campaign
    const existing = Array.from(this.analyticsData.values()).find(
      a => a.campaignId === insertAnalytics.campaignId
    );
    
    if (existing) {
      const updated = { 
        ...existing, 
        ...insertAnalytics,
        updatedAt: new Date(),
        sent: insertAnalytics.sent ?? existing.sent,
        delivered: insertAnalytics.delivered ?? existing.delivered,
        read: insertAnalytics.read ?? existing.read,
        optout: insertAnalytics.optout ?? existing.optout,
        hold: insertAnalytics.hold ?? existing.hold,
        failed: insertAnalytics.failed ?? existing.failed
      };
      this.analyticsData.set(existing.id, updated);
      return updated;
    }
    
    // Create new analytics
    const id = this.analyticsCurrentId++;
    const updatedAt = new Date();
    const analytics: Analytics = { 
      ...insertAnalytics, 
      id, 
      updatedAt,
      sent: insertAnalytics.sent || 0,
      delivered: insertAnalytics.delivered || 0,
      read: insertAnalytics.read || 0,
      optout: insertAnalytics.optout || 0,
      hold: insertAnalytics.hold || 0,
      failed: insertAnalytics.failed || 0
    };
    this.analyticsData.set(id, analytics);
    return analytics;
  }
  
  // SETTINGS METHODS
  async getSettings(accountId: number): Promise<Settings | undefined> {
    return Array.from(this.settingsData.values()).find(
      (settings) => settings.accountId === accountId
    );
  }
  
  async updateSettings(accountId: number, settingsData: Partial<InsertSettings>): Promise<Settings> {
    // Check if settings already exist for this account
    const existing = await this.getSettings(accountId);
    
    if (existing) {
      // Update existing settings
      const updated = { 
        ...existing, 
        ...settingsData,
        updatedAt: new Date()
      };
      this.settingsData.set(existing.id, updated);
      return updated;
    }
    
    // Create new settings
    const id = this.settingsCurrentId++;
    const updatedAt = new Date();
    const settings: Settings = { 
      id, 
      accountId,
      updatedAt,
      wabaApiUrl: settingsData.wabaApiUrl || null,
      facebookAccessToken: settingsData.facebookAccessToken || null,
      partnerMobile: settingsData.partnerMobile || null,
      wabaId: settingsData.wabaId || null,
      campaignApiKey: settingsData.campaignApiKey || null
    };
    this.settingsData.set(id, settings);
    return settings;
  }
}

// Use database storage if DATABASE_URL is provided, otherwise use in-memory storage
export const storage = DB_CONFIG.url 
  ? new DatabaseStorage() 
  : new MemStorage();