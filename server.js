const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin with service account from environment variables
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Notification server is running',
    endpoints: {
      sendBroadcast: 'POST /api/send-broadcast',
      history: 'GET /api/broadcast-history'
    }
  });
});

// Endpoint to send broadcast notifications - COMPLETELY FIXED VERSION
app.post('/api/send-broadcast', async (req, res) => {
  try {
    const { message, audience, adminId } = req.body;
    
    console.log(`📢 Sending broadcast to "${audience}": "${message}"`);
    console.log(`📦 Request body:`, req.body);

    // Validate input
    if (!message || !audience || !adminId) {
      return res.status(400).json({ 
        error: 'Missing required fields: message, audience, adminId' 
      });
    }

    // 1. Save to Firestore for history
    const broadcastRef = await db.collection('broadcast_notifications').add({
      message,
      audience,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      sentBy: adminId,
      status: 'pending'
    });
    console.log(`✅ Saved broadcast to Firestore with ID: ${broadcastRef.id}`);

    // 2. Get FCM tokens - WITH DETAILED LOGGING
    let tokens = [];

    if (audience === 'all') {
      console.log('🔍 Fetching tokens for ALL users');
      
      // Get all users with FCM tokens
      const usersSnapshot = await db.collection('users')
        .where('fcmToken', '!=', null)
        .get();
      
      console.log(`📊 Found ${usersSnapshot.size} users with tokens`);
      usersSnapshot.forEach(doc => {
        const data = doc.data();
        const token = data.fcmToken;
        const role = data.role || 'unknown';
        if (token) {
          tokens.push(token);
          console.log(`   👤 User (${role}): ${token.substring(0, 20)}...`);
        }
      });

      // Check doctors collection
      const doctorsSnapshot = await db.collection('doctors')
        .where('fcmToken', '!=', null)
        .get();
      
      console.log(`📊 Found ${doctorsSnapshot.size} doctors with tokens`);
      doctorsSnapshot.forEach(doc => {
        const token = doc.data().fcmToken;
        if (token) {
          tokens.push(token);
          console.log(`   👨‍⚕️ Doctor: ${token.substring(0, 20)}...`);
        }
      });

      // Check CHWs collection
      const chwSnapshot = await db.collection('chws')
        .where('fcmToken', '!=', null)
        .get();
      
      console.log(`📊 Found ${chwSnapshot.size} CHWs with tokens`);
      chwSnapshot.forEach(doc => {
        const token = doc.data().fcmToken;
        if (token) {
          tokens.push(token);
          console.log(`   👥 CHW: ${token.substring(0, 20)}...`);
        }
      });

    } else {
      const targetRole = audience.toLowerCase();
      console.log(`🔍 Fetching tokens for "${targetRole}" users (case-insensitive)`);
      
      // FIRST: Check role-specific collections directly (most reliable)
      if (targetRole === 'chws' || targetRole === 'chw') {
        console.log('   📁 Checking chws collection directly...');
        const chwSnapshot = await db.collection('chws')
          .where('fcmToken', '!=', null)
          .get();
        
        console.log(`   Found ${chwSnapshot.size} CHWs with tokens in chws collection`);
        chwSnapshot.forEach(doc => {
          const token = doc.data().fcmToken;
          if (token) {
            tokens.push(token);
            console.log(`   ✓ CHW token: ${token.substring(0, 20)}...`);
          }
        });
      }
      
      if (targetRole === 'doctors' || targetRole === 'doctor') {
        console.log('   📁 Checking doctors collection directly...');
        const doctorsSnapshot = await db.collection('doctors')
          .where('fcmToken', '!=', null)
          .get();
        
        console.log(`   Found ${doctorsSnapshot.size} doctors with tokens in doctors collection`);
        doctorsSnapshot.forEach(doc => {
          const token = doc.data().fcmToken;
          if (token) {
            tokens.push(token);
            console.log(`   ✓ Doctor token: ${token.substring(0, 20)}...`);
          }
        });
      }
      
      // SECOND: Check users collection with flexible role matching
      console.log('   📁 Checking users collection with role filtering...');
      const usersSnapshot = await db.collection('users')
        .where('fcmToken', '!=', null)
        .get();
      
      console.log(`   Found ${usersSnapshot.size} users with tokens to check`);
      
      let matched = 0;
      usersSnapshot.forEach(doc => {
        const userData = doc.data();
        const userRole = userData.role ? userData.role.toString() : '';
        const token = userData.fcmToken;
        const userId = doc.id;
        
        // Case-insensitive matching with multiple variations
        const isMatch = 
          userRole.toLowerCase() === targetRole ||
          userRole.toLowerCase() === targetRole.slice(0, -1) || // remove 's' for plural
          (targetRole === 'chws' && userRole.toLowerCase() === 'chw') ||
          (targetRole === 'doctors' && userRole.toLowerCase() === 'doctor');
        
        if (token && isMatch) {
          tokens.push(token);
          matched++;
          console.log(`   ✓ User ${userId} (role: ${userRole}) token: ${token.substring(0, 20)}...`);
        } else if (token) {
          console.log(`   ✗ User ${userId} role "${userRole}" doesn't match "${targetRole}"`);
        }
      });
      console.log(`   Matched ${matched} users from users collection`);
    }

    // Remove duplicate tokens (same device might be in multiple collections)
    const uniqueTokens = [...new Set(tokens)];
    console.log(`📱 Total unique devices found: ${uniqueTokens.length} (from ${tokens.length} total entries)`);

    // 3. Send notifications
    let successCount = 0;
    let failureCount = 0;

    if (uniqueTokens.length > 0) {
      console.log(`📨 Sending notifications to ${uniqueTokens.length} devices...`);
      
      // Send to multiple tokens at once (max 500 per batch)
      const messagePayload = {
        notification: {
          title: '📢 System Announcement',
          body: message,
        },
        data: {
          type: 'broadcast',
          message: message,
          sentAt: Date.now().toString(),
        },
        tokens: uniqueTokens,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(messagePayload);
        successCount = response.successCount;
        failureCount = response.failureCount;
        
        console.log(`✅ Successfully sent: ${successCount}`);
        console.log(`❌ Failed: ${failureCount}`);
        
        // Log failed tokens if any
        if (failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              console.log(`   ❌ Token ${idx}: ${resp.error}`);
            }
          });
        }
      } catch (fcmError) {
        console.error('❌ FCM Error:', fcmError);
      }
    } else {
      console.log('⚠️ No devices found to notify');
    }

    // 4. Update broadcast status
    await broadcastRef.update({
      status: 'sent',
      recipientCount: uniqueTokens.length,
      successCount,
      failureCount
    });

    res.json({ 
      success: true, 
      count: uniqueTokens.length,
      successCount,
      failureCount,
      broadcastId: broadcastRef.id,
      details: {
        tokensFound: tokens.length,
        uniqueTokens: uniqueTokens.length
      }
    });

  } catch (error) {
    console.error('❌ Broadcast error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

// Endpoint to get broadcast history
app.get('/api/broadcast-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const snapshot = await db.collection('broadcast_notifications')
      .orderBy('sentAt', 'desc')
      .limit(limit)
      .get();

    const history = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      history.push({
        id: doc.id,
        message: data.message || '',
        audience: data.audience || 'all',
        sentAt: data.sentAt ? data.sentAt.toDate().toISOString() : new Date().toISOString(),
        sentBy: data.sentBy || '',
        status: data.status || 'unknown',
        recipientCount: data.recipientCount || 0,
        successCount: data.successCount || 0,
        failureCount: data.failureCount || 0
      });
    });

    res.json(history);
  } catch (error) {
    console.error('❌ Error fetching history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get notification stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalSnapshot = await db.collection('broadcast_notifications').count().get();
    const total = totalSnapshot.data().count;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todaySnapshot = await db.collection('broadcast_notifications')
      .where('sentAt', '>=', today)
      .count()
      .get();
    
    const todayCount = todaySnapshot.data().count;

    res.json({
      total,
      today: todayCount
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint to check Firestore structure
app.get('/api/debug/collections', async (req, res) => {
  try {
    const result = {
      users: { total: 0, withTokens: 0, roles: {} },
      chws: { total: 0, withTokens: 0 },
      doctors: { total: 0, withTokens: 0 }
    };
    
    // Check users collection
    const usersSnapshot = await db.collection('users').get();
    result.users.total = usersSnapshot.size;
    
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      const role = data.role || 'unknown';
      const hasToken = !!data.fcmToken;
      
      if (!result.users.roles[role]) {
        result.users.roles[role] = { total: 0, withTokens: 0 };
      }
      result.users.roles[role].total++;
      if (hasToken) {
        result.users.withTokens++;
        result.users.roles[role].withTokens++;
      }
    });
    
    // Check chws collection
    const chwsSnapshot = await db.collection('chws').get();
    result.chws.total = chwsSnapshot.size;
    chwsSnapshot.forEach(doc => {
      if (doc.data().fcmToken) result.chws.withTokens++;
    });
    
    // Check doctors collection
    const doctorsSnapshot = await db.collection('doctors').get();
    result.doctors.total = doctorsSnapshot.size;
    doctorsSnapshot.forEach(doc => {
      if (doc.data().fcmToken) result.doctors.withTokens++;
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Notification server running on port ${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   - GET  /`);
  console.log(`   - POST /api/send-broadcast`);
  console.log(`   - GET  /api/broadcast-history`);
  console.log(`   - GET  /api/stats`);
  console.log(`   - GET  /api/debug/collections`);
});
