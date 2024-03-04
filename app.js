require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const mysql = require('mysql');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const uuid = require('uuid');

const app = express();
const privateKey = process.env.ACCESS_TOKEN_SECRET;

// Parse JSON and urlencoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection pooling
const pool = mysql.createPool({
    connectionLimit: 10,
    host: process.env.CLOUD_SQL_PUBLIC_IP,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    socketPath: process.env.SOCKET_PATH
});

// Caching setup
const userCache = new NodeCache({ stdTTL: 100, checkperiod: 120 });

// Security enhancements
app.use(cors());
app.use(helmet());

// Trust the first proxy (adjust according to your deployment)
app.set('trust proxy', 1);

// Apply rate limiting
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
}));

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  jwt.verify(token, privateKey, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Failed to authenticate token' });
    }
    req.sessionId = decoded;
    req.encryptedSessionId = token;
    next();
  });
};

// Middleware to check authentication
const checkAuth = async (req, res, next) => {
  try {
    const response = await axios.get(process.env.checkAuth_SERVICE_ENDPOINT, {
      headers: {
        Authorization: req.sessionId
      }
    });
    if (response.data.isAuthenticated) {
      req.userId = response.data.user_id;
      req.userRole = response.data.role; // Store user role
      req.username = response.data.username; // Store username
      next();
    } else {
      return res.status(401).json({ message: 'User not authenticated' });
    }
  } catch (error) {
    next(error);
  }
};

// Create a new mining account
app.post('/create-mining-account', verifyToken, checkAuth, async (req, res) => {
  const userId = req.userId;
  const initialPoints = process.env.MINNE_AMOUNT || '0'; // Default to '0' if MINNE_AMOUNT is not set
  const miningRate = 1; // Assuming an initial mining rate of 1, adjust as necessary
  const claimsToday = 0;
  const currentDate = new Date().toISOString().slice(0, 10); // Format current date to YYYY-MM-DD
  const currentDateTime = new Date().toISOString(); // Current date and time in ISO format
  const formattedNextClaimPossible = currentDateTime.slice(0, 19).replace('T', ' ');

  const exsistingAccount = await checkUserExsistence(req.userId);
    if (exsistingAccount) {
      return res.status(200).json({ message: 'Account Already Created' });
  }
  // Prepare the insert query to use MINNE_AMOUNT for the initial points
  const insertQuery = `INSERT INTO token_match_reward_minne (user_id, points, mining_rate, claims_today, last_claim, next_claim_possible) VALUES (?, ?, ?, ?, ?, ?)`;

  // Execute the query with the initialPoints and other values
  pool.query(insertQuery, [userId, initialPoints, miningRate, claimsToday, currentDate, formattedNextClaimPossible], (error, results) => {
      if (error) {
          return res.status(500).json({ message: 'Failed to create mining account', error });
      }
      res.json({ message: 'Mining account created successfully', accountId: results.insertId });
  });

});


// Claim mining balance endpoint
app.post('/claim-mining-balance', verifyToken, checkAuth, async (req, res) => {
  const userId = req.userId;
  const maxDailyClaims = parseInt(process.env.MAX_DAILY_CLAIMS, 10) || 1; // Default to 1 if not specified
  const nextClaimInterval = parseInt(process.env.NEXT_CLAIM_INTERVAL || '24', 10); // Default to 24 hours if not specified

  // First, check if user has enough balance to claim
  const userBalance = await getUserMinnedTokenBalnce(userId);
  if (userBalance < parseFloat(process.env.MINNE_AMOUNT)) {
    return res.status(400).json({ message: 'Not Enough Balance to Claim' });
  }

  pool.getConnection(async (err, connection) => {
    if (err) {
      return res.status(500).json({ message: 'Failed to get database connection', err });
    }
    connection.beginTransaction(async err => {
      if (err) {
        connection.release();
        return res.status(500).json({ message: 'Transaction start failed', err });
      }

      const checkClaimsQuery = `SELECT points, mining_rate, claims_today, last_claim, next_claim_possible FROM token_match_reward_minne WHERE user_id = ?`;
      
      connection.query(checkClaimsQuery, [userId], (error, results) => {
        if (error || results.length === 0) {
          connection.rollback(() => connection.release());
          return res.status(500).json({ message: 'Eligibility check failed', error });
        }

        const { points, mining_rate, claims_today, last_claim, next_claim_possible } = results[0];
        
        const today = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const lastClaim = new Date(results[0].last_claim); // Convert last_claim to Date object if necessary
        const hasClaimsLeft = claims_today < maxDailyClaims || lastClaim < today;

        if (!hasClaimsLeft) {
          connection.rollback(() => connection.release());
          return res.status(400).json({ message: 'No claims left for today' });
        }

        const newClaimsToday = last_claim < today ? 1 : claims_today + 1;
        const currentDate = new Date();
        const nextClaimDate = new Date(currentDate.getTime() + nextClaimInterval * 60 * 60 * 1000); // Calculate next claim date
        const formattedNextClaimPossible = nextClaimDate.toISOString().slice(0, 19).replace('T', ' ');

        // Adjust pointsToAdd by multiplying with the user's mining rate
        const pointsToAdd = parseFloat(process.env.MINNE_AMOUNT) * mining_rate;

        const addPointsQuery = `UPDATE token_match_reward_minne SET points = ?, claims_today = ?, last_claim = ?, next_claim_possible = ? WHERE user_id = ?`;
        connection.query(addPointsQuery, [pointsToAdd, newClaimsToday, today, formattedNextClaimPossible, userId], async (error, results) => {
          if (error) {
            connection.rollback(() => connection.release());
            return res.status(500).json({ message: 'Updating mining balance failed', error });
          }

          // Now, update the user's points in the users table
          const updateUserPointsQuery = `UPDATE users SET points = points + ? WHERE user_id = ?`;
          connection.query(updateUserPointsQuery, [pointsToAdd, userId], (error, results) => {
            if (error) {
              connection.rollback(() => connection.release());
              return res.status(500).json({ message: 'Failed to update user points', error });
            }

            // If all operations are successful, commit the transaction
            connection.commit(err => {
              if (err) {
                connection.rollback(() => connection.release());
                return res.status(500).json({ message: 'Failed to commit transaction', err });
              }
              connection.release();
              res.json({ message: 'Claimed successfully', claimedPoints: pointsToAdd });
            });
          });
        });
      });
    });
  });
});




// Update mining rate
// app.post('/update-mining-rate', verifyToken, checkAuth, async (req, res) => {
//     const userId = req.userId;
//     const miningRateBoost = parseFloat(process.env.MINING_RATE_BOOST);

//     const updateQuery = `UPDATE token_match_reward_minne SET mining_rate = mining_rate + ? WHERE user_id = ?`;
//     pool.query(updateQuery, [miningRateBoost, userId], (error, results) => {
//         if (error) {
//             return res.status(500).json({ message: 'Failed to update mining rate', error });
//         }
//         res.json({ message: 'Mining rate updated successfully' });
//     });
// });

// Get user mining balance
// app.get('/get-mining-balance', verifyToken, checkAuth, async (req, res) => {
//   const userId = req.userId;
//   let balance = await getUserMinnedTokenBalnce(userId);
//   let minneAmount = parseFloat(process.env.MINNE_AMOUNT);
//   let floatRatio = balance / minneAmount;
//   if(balance >= process.env.MINNE_AMOUNT){
//     res.json({ balance: balance, floatRatio: floatRatio,  fullBalanceBox: true });
//   }else{
//     res.json({ balance: balance, floatRatio: floatRatio, fullBalanceBox: false });
//   }
// });

// Get user mining balance
app.get('/get-mining-balance', verifyToken, checkAuth, async (req, res) => {
  const userId = req.userId;
  let balance = await getUserMinnedTokenBalnce(userId);
  let minneAmount = parseFloat(process.env.MINNE_AMOUNT);
  let floatRatio = balance / minneAmount;
  if(balance >= process.env.MINNE_AMOUNT){
    res.json({ balance: balance, fullBalanceBox: true });
  }else{
    res.json({ balance: balance, fullBalanceBox: false });
  }
});

// Get user account details
app.get('/get-mining-account-details', verifyToken, checkAuth, async (req, res) => {
  const userId = req.userId;
  const userDetails = await getUserAccountDetails(userId);
  res.json(userDetails);
});

async function getUserMinnedTokenBalnce(userId) {
  return new Promise((resolve, reject) => {
  const selectQuery = `SELECT points, last_claim, next_claim_possible, mining_rate FROM token_task_minne WHERE user_id = ?`;
  pool.query(selectQuery, [userId], (error, results) => {
      if (error || results.length === 0) {
          reject(error);
      }

      const { points, last_claim, next_claim_possible, mining_rate } = results[0];
      const currentTime = new Date();
      const nextClaimTime = new Date(next_claim_possible);
      const lastClaimTime = new Date(last_claim);

      // Calculate the proportion of the current time between the last claim and the next possible claim
      const totalTime = nextClaimTime.getTime() - lastClaimTime.getTime();
      const elapsedTime = currentTime.getTime() - lastClaimTime.getTime();
      const proportion = Math.min(elapsedTime / totalTime, 1); // Ensure the proportion does not exceed 1

      const adjustedPoints = points * proportion; // Calculate the adjusted points based on the proportion
      if(adjustedPoints <= process.env.MINNE_AMOUNT){
        resolve(adjustedPoints);
      }else{
        resolve(parseFloat(process.env.MINNE_AMOUNT * mining_rate));
      }
      
  });
});
}


async function checkUserExsistence(user_id) {
  return new Promise((resolve, reject) => {
    const query = 'SELECT user_id FROM token_match_reward_minne WHERE user_id = ?';
    pool.query(query, [user_id], (err, results) => {
      if (err) {
        console.error('MySQL Database Error:', err);
        reject(err);
      } else {
        resolve(results[0]); // Assuming session_id is unique and returns a single row
      }
    });
  });
}

async function getUserAccountDetails(user_id) {
  return new Promise((resolve, reject) => {
    const query = 'SELECT mining_rate,last_claim,next_claim_possible,created_at,claims_today,last_claim FROM token_match_reward_minne WHERE user_id = ?';
    pool.query(query, [user_id], (err, results) => {
      if (err) {
        console.error('MySQL Database Error:', err);
        reject(err);
      } else {
        resolve(results[0]); // Assuming session_id is unique and returns a single row
      }
    });
  });
}

// Health Check Endpoint
app.get('/health', (req, res) => {
    pool.query('SELECT 1', (err, results) => {
        if (err) {
            return res.status(500).json({ message: 'Database connection failed', error: err });
        }
        res.json({ message: 'Micro-service active and database connection successful' });
    });
});

// Central error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Internal Server Error' });
});

// Starting the server
const PORT = process.env.APP_PORT || 8080;
app.listen(PORT, () => {
    console.log(`Micro-service listening on port ${PORT}`);
});
