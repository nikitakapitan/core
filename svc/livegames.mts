// Updates the list of currently live games
import async from 'async';
import JSONbig from 'json-bigint';
import request from 'request';
import redis from '../store/redis.mts';
import db from '../store/db.mjs';
import config from '../config.js';
import { invokeInterval } from '../util/utility.mjs';
function doLiveGames(cb: (err?: any) => void) {
  // Get the list of pro players
  db.select()
    .from('notable_players')
    .asCallback((err: any, proPlayers: ProPlayer[]) => {
      // Get the list of live games
      const apiKeys = config.STEAM_API_KEY.split(',');
      const liveGamesUrl = `https://api.steampowered.com/IDOTA2Match_570/GetTopLiveGame/v1/?key=${apiKeys[0]}&partner=0`;
      request.get(liveGamesUrl, (err: any, resp: any, body: any) => {
        if (err) {
          return cb(err);
        }
        const json = JSONbig.parse(body);
        // If a match contains a pro player
        // add their name to the match object, save it to redis zset, keyed by server_steam_id
        return async.eachSeries(
          json.game_list,
          (match: LiveMatch, cb: Function) => {
            // let addToRedis = false;
            if (match && match.players) {
              match.players.forEach((player, i) => {
                const proPlayer = proPlayers.find(
                  (proPlayer) =>
                    proPlayer.account_id.toString() ===
                    player.account_id.toString()
                );
                if (proPlayer) {
                  match.players[i] = { ...player, ...proPlayer };
                  // addToRedis = true;
                }
              });
              // convert the BigInt to a string
              match.lobby_id = match.lobby_id.toString();
              redis.zadd('liveGames', match.lobby_id, match.lobby_id);
              redis.setex(
                `liveGame:${match.lobby_id}`,
                28800,
                JSON.stringify(match)
              );
              // Keep only the 100 highest values
              redis.zremrangebyrank('liveGames', '0', '-101');
            }
            cb();
            // Get detailed stats for each live game
            // const { url } = utility.generateJob('api_realtime_stats', {
            //   server_steam_id: match.server_steam_id
            // }).url;
          },
          cb
        );
      });
    });
}
invokeInterval(doLiveGames, 60 * 1000);