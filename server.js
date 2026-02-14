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

// Endpoint to send broadcast notifications
app.post('/api/send-broadcast', async (req, res) => {
  try {
    const { message, audience, adminId } = req.body;
    
    console.log(`📢 Sending broadcast to ${audience}: ${message}`);

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

    // 2. Get FCM tokens based on audience
    let tokens = [];
    let usersSnapshot;

    if (audience === 'all') {
      // Get all users with FCM tokens
      usersSnapshot = await db.collection('users')
        .where('fcmToken', '!=', null)
        .get();
      
      usersSnapshot.forEach(doc => {
        const token = doc.data().fcmToken;
        if (token) tokens.push(token);
      });

      // Also check doctors collection
      const doctorsSnapshot = await db.collection('doctors')
        .where('fcmToken', '!=', null)
        .get();
      
      doctorsSnapshot.forEach(doc => {
        const token = doc.data().fcmToken;
        if (token) tokens.push(token);
      });

      // Check CHWs collection
      const chwSnapshot = await db.collection('chws')
        .where('fcmToken', '!=', null)
        .get();
      
      chwSnapshot.forEach(doc => {
        const token = doc.data().fcmToken;
        if (token) tokens.push(token);
      });

    } else {
      // Get users with specific role
      usersSnapshot = await db.collection('users')
        .where('role', '==', audience)
        .where('fcmToken', '!=', null)
        .get();
      
      usersSnapshot.forEach(doc => {
        const token = doc.data().fcmToken;
        if (token) tokens.push(token);
      });
    }

    console.log(`📱 Found ${tokens.length} devices to notify`);

    // 3. Send notifications
    let successCount = 0;
    let failureCount = 0;

    if (tokens.length > 0) {
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
        tokens: tokens,
      };

      try {
        const response = await admin.messaging().sendEachForMulticast(messagePayload);
        successCount = response.successCount;
        failureCount = response.failureCount;
        
        console.log(`✅ Success: ${successCount}, Failed: ${failureCount}`);
      } catch (fcmError) {
        console.error('FCM Error:', fcmError);
      }
    }

    // 4. Update broadcast status
    await broadcastRef.update({
      status: 'sent',
      recipientCount: tokens.length,
      successCount,
      failureCount
    });

    res.json({ 
      success: true, 
      count: tokens.length,
      successCount,
      failureCount,
      broadcastId: broadcastRef.id
    });

  } catch (error) {
    console.error('❌ Broadcast error:', error);
    res.status(500).json({ error: error.message });
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
        message: data.message,
        audience: data.audience,
        sentAt: data.sentAt?.toDate().toISOString(),
        sentBy: data.sentBy,
        status: data.status,
        recipientCount: data.recipientCount || 0,
        successCount: data.successCount || 0,
        failureCount: data.failureCount || 0
      });
    });

    res.json(history);
  } catch (error) {
    console.error('Error fetching history:', error);
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
    console.error('Error fetching stats:', error);
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
});