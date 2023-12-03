// Updates the list of leagues in the database
import async from 'async';
import utility from '../util/utility.mjs';
import db from '../store/db.mjs';
import queries from '../store/queries.mjs';
const { invokeInterval, generateJob, getData } = utility;
function doLeagues(cb) {
  const container = generateJob('api_leagues', {});
  getData(container.url, (err, apiLeagues) => {
    if (err) {
      return cb(err);
    }
    return async.each(
      apiLeagues.infos,
      (league, cb) => {
        const openQualifierTier =
          league.name.indexOf('Open Qualifier') === -1 ? null : 'excluded';
        let eventTier = 'excluded';
        if (league.tier === 2) {
          eventTier = 'professional';
        } else if (league.tier >= 3) {
          eventTier = 'premium';
        }
        if (league.league_id === 4664) {
          eventTier = 'premium';
        }
        league.tier = openQualifierTier || eventTier || null;
        league.ticket = null;
        league.banner = null;
        league.leagueid = league.league_id;
        queries.upsert(
          db,
          'leagues',
          league,
          {
            leagueid: league.league_id,
          },
          cb
        );
      },
      cb
    );
  });
}
invokeInterval(doLeagues, 30 * 60 * 1000);