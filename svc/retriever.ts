/**
 * Deployed in the cloud to get data from the Steam GC.
 * Provides HTTP endpoints for other workers.
 * Approx limits: 100 per account per day, 500 per IP per day
 * */
import SteamUser from 'steam-user';
import express from 'express';
import compression from 'compression';
import os from 'os';
import config from '../config';
import ProtoBuf from 'protobufjs';
import axios from 'axios';

const app = express();
const steamObj: Record<string, SteamUser> = {};
const minUpTimeSeconds = 300;

const numAccounts = 5;
const matchesPerAccount = 100;
const port = config.PORT || config.RETRIEVER_PORT;
const getMatchRequestInterval = () => {
  return Math.ceil(2000 / (Object.keys(steamObj).length || 1));
};
const noneReady = () =>
  Object.values(steamObj).filter((client) => client.steamID).length === 0;
let lastMatchRequestTime: number | null = null;
let matchRequests = 0;
let matchSuccesses = 0;
let profileRequests = 0;
let profileSuccesses = 0;
const matchAttempts: Record<string, number> = {};
const DOTA_APPID = 570;
let publicIP = '';

const root = new ProtoBuf.Root();
const builder = root.loadSync(
  [
    './proto/gcsystemmsgs.proto',
    './proto/enums_clientserver.proto',
    './proto/dota_gcmessages_msgid.proto',
    './proto/dota_gcmessages_client.proto',
  ],
  {
    keepCase: true,
  },
);
const EGCBaseClientMsg = builder.lookupEnum('EGCBaseClientMsg');
const EDOTAGCMsg = builder.lookupEnum('EDOTAGCMsg');
const CMsgClientToGCGetProfileCard = builder.lookupType(
  'CMsgClientToGCGetProfileCard',
);
const CMsgDOTAProfileCard = builder.lookupType('CMsgDOTAProfileCard');
const CMsgGCMatchDetailsRequest = builder.lookupType(
  'CMsgGCMatchDetailsRequest',
);
const CMsgGCMatchDetailsResponse = builder.lookupType(
  'CMsgGCMatchDetailsResponse',
);

setInterval(() => {
  const shouldRestart =
    (matchRequests - matchSuccesses > 100 && getUptime() > minUpTimeSeconds) ||
    (matchRequests > Object.keys(steamObj).length * matchesPerAccount &&
      getUptime() > minUpTimeSeconds) ||
    (profileRequests - profileSuccesses > 1000 &&
      getUptime() > minUpTimeSeconds) ||
    (noneReady() && getUptime() > minUpTimeSeconds);
  if (shouldRestart && config.NODE_ENV !== 'development') {
    return selfDestruct();
  }
  // Re-register ourselves as available
  if (config.SERVICE_REGISTRY_HOST && !noneReady()) {
    const registerUrl = `https://${
      config.SERVICE_REGISTRY_HOST
    }/register/retriever/${publicIP}?key=${
      config.RETRIEVER_SECRET
    }`;
    console.log('registerUrl: %s', registerUrl);
    axios.post(registerUrl);
  }
}, 5000);

app.get('/healthz', (req, res, cb) => {
  return res.end('ok');
});
app.use(compression());
app.get('/stats', async (req, res, cb) => {
  return res.json(genStats());
});
app.use((req, res, cb) => {
  console.log(
    'numReady: %s, matches: %s/%s, profiles: %s/%s, uptime: %s, matchRequestDelay: %s, query: %s',
    Object.keys(steamObj).length,
    matchSuccesses,
    matchRequests,
    profileSuccesses,
    profileRequests,
    getUptime(),
    getMatchRequestInterval(),
    req.query,
  );
  if (config.RETRIEVER_SECRET && config.RETRIEVER_SECRET !== req.query.key) {
    // reject request if it doesn't have key
    return cb('invalid key');
  }
  if (noneReady()) {
    return cb('not ready');
  }
  return cb();
});
app.get('/profile/:account_id', async (req, res, cb) => {
  const keys = Object.keys(steamObj);
  const rKey = keys[Math.floor(Math.random() * keys.length)];
  const accountId = req.params.account_id;
  const client = steamObj[rKey];
  profileRequests += 1;
  client.sendToGC(
    DOTA_APPID,
    EDOTAGCMsg.values.k_EMsgClientToGCGetProfileCard,
    {},
    Buffer.from(
      CMsgClientToGCGetProfileCard.encode({
        account_id: Number(accountId),
      }).finish(),
    ),
    (appid, msgType, payload) => {
      // console.log(appid, msgType, payload);
      profileSuccesses += 1;
      const profileCard = CMsgDOTAProfileCard.decode(payload);
      return res.json(profileCard);
    },
  );
});
app.get('/match/:match_id', async (req, res, cb) => {
  // Don't allow requests coming in too fast
  const curTime = Number(new Date());
  if (
    lastMatchRequestTime &&
    curTime - lastMatchRequestTime < getMatchRequestInterval()
  ) {
    return res.status(429).json({
      error: 'too many requests',
    });
  }
  lastMatchRequestTime = curTime;
  const keys = Object.keys(steamObj);
  // Round robin request to spread load evenly
  const rKey = keys[matchRequests % keys.length];
  const matchId = req.params.match_id;
  const client = steamObj[rKey];
  matchRequests += 1;
  // If the selected client has multiple consecutive failures, skip the request
  if (matchAttempts[rKey] >= 5) {
    return res.status(500).end();
  }
  res.setHeader('x-match-request-steamid', rKey);
  res.setHeader('x-match-request-ip', publicIP);
  matchAttempts[rKey] = (matchAttempts[rKey] ?? 0) + 1;
  console.time('match:' + matchId);
  const timeout = setTimeout(() => {
    // Respond after 4 seconds to send back header info
    // Currently consumers are configured to fail after 5 seconds
    // Use a 200 status code to avoid exception, we'll check the response body after
    console.timeEnd('match:' + matchId);
    res.end();
  }, 4000);
  client.sendToGC(
    DOTA_APPID,
    EDOTAGCMsg.values.k_EMsgGCMatchDetailsRequest,
    {},
    Buffer.from(
      CMsgGCMatchDetailsRequest.encode({ match_id: Number(matchId) }).finish(),
    ),
    (appid, msgType, payload) => {
      clearTimeout(timeout);
      // Check if we already sent the response to avoid double-sending on slow requests
      if (!res.headersSent) {
        console.timeEnd('match:' + matchId);
        const matchData: any = CMsgGCMatchDetailsResponse.decode(payload);
        if (matchData.result === 15) {
          // Valve is blocking GC access to this match, probably a community prediction match
          // Send back 200 success with a specific header that tells us not to retry
          res.setHeader('x-match-noretry', matchData.result);
          return res.end();
        }
        matchSuccesses += 1;
        // Reset on success
        delete matchAttempts[rKey];
        return res.json(matchData);
      }
    },
  );
});
app.get('/aliases/:steam_ids', async (req, res, cb) => {
  // example: 76561198048632981
  const keys = Object.keys(steamObj);
  const rKey = keys[Math.floor(Math.random() * keys.length)];
  const client = steamObj[rKey];
  client.getAliases(req.params.steam_ids?.split(','), (err, aliases) => {
    if (err) {
      return cb(err);
    }
    return res.json(aliases);
  });
});

async function start() {
  init();
  app.listen(port, () => {
    console.log('[RETRIEVER] listening on %s', port);
  });
}
start();

async function init() {
  let logOns: { accountName: string; password: string }[] | null = null;
  if (config.SERVICE_REGISTRY_HOST) {
    // Fetch logons from remote
    while (!logOns?.length) {
      try {
        const logOnUrl =
          'https://' +
          config.SERVICE_REGISTRY_HOST +
          '/retrieverData?key=' +
          config.RETRIEVER_SECRET
          + '&count=' + numAccounts;
        console.log('logOnUrl: %s', logOnUrl);
        const resp = await axios.get(logOnUrl);
        logOns = resp.data;
      } catch (e) {
        console.warn(e);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } else {
    // Generate logons from config
    let users = config.STEAM_USER.split(',');
    let passes = config.STEAM_PASS.split(',');
    logOns = users.map((u, i) => ({
      accountName: u,
      password: passes[i],
    }));
  }
  // Some logins may fail, and sometimes the Steam CM never returns a response
  // So don't await init and we'll just make sure we have at least one working with noneReady
  await Promise.allSettled(
    logOns.map(
      (logOnDetails) =>
        new Promise<void>((resolve, reject) => {
          const client = new SteamUser();
          client.on('loggedOn', () => {
            console.log('[STEAM] Logged on %s', logOnDetails.accountName);
            // Get our public IP from Steam
            publicIP = client.publicIP;
            // Launch Dota 2
            client.gamesPlayed(DOTA_APPID);
          });
          client.on('appLaunched', (appid) => {
            client.sendToGC(
              appid,
              EGCBaseClientMsg.values.k_EMsgGCClientHello,
              {},
              Buffer.alloc(0),
            );
          });
          client.on('receivedFromGC', (appid, msgType, payload) => {
            // We'll get Hello response here
            console.log(
              `Received message ${msgType} from GC ${appid} with ${payload.length} bytes`,
            );
            if (msgType === EGCBaseClientMsg.values.k_EMsgGCClientWelcome) {
              if (!client.steamID) {
                reject('client not connected');
                return;
              }
              console.log(
                'ready: %s (%s)',
                logOnDetails.accountName,
                client.steamID.toString(),
              );
              steamObj[logOnDetails.accountName] = client;
              resolve();
            }
            // We can also handle other GC responses here if not using callbacks
          });
          client.on('error', (err: any) => {
            console.error(err);
            reject(err);
          });
          client.logOn(logOnDetails);
        }),
    ),
  );
}
function selfDestruct() {
  console.log('shutting down');
  process.exit(0);
}
function getUptime() {
  return process.uptime();
}
function getOSUptime() {
  return os.uptime();
}
function genStats() {
  const data = {
    matchRequests,
    matchSuccesses,
    profileRequests,
    profileSuccesses,
    uptime: getUptime(),
    osUptime: getOSUptime(),
    hostname: os.hostname(),
    numReadyAccounts: Object.keys(steamObj).length,
  };
  return data;
}
