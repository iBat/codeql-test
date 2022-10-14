const logError = require('./utils').logError;
const logInfo = require('./utils').logInfo;
const MongoClient = require('mongodb').MongoClient;
const Long = require('mongodb').Long;
const _ = require('lodash');

const config = require('./config');
const utils = require('./utils');
const httpUtils = require('./utils/http');
const statUtils = require('./utils/stat');
const db = require('./sql').db;

let clans;
let players;
let missed;
let tokens;
let usersCommon;

const serverQueues = {};
const serverStats = {};
const serverLocks = {};
const queueUpdateLocks = {};

const BATTLES_TRASH_HOLD = config.battlesTrashHold;
const PLAYERS_UPDATE_TRASHHOLD = 11 * 24 * 60 * 60 * 1000; // 11 days
const PLAYER_POOL_SIZE = config.updater.playersPoolSize;
const PLAYERS_FETCH_THRESHOLD = config.updater.playersFetchThreshold;
const HTTP_BATCH_SIZE = config.updater.httpBatchSize;
const MAX_RETRIES = 3;
const hour = 3600 * 1000;
const postponeIntervals = [ hour, 4 * hour, 8 * hour ];

Promise.all([
    MongoClient.connect(`mongodb://${process.env.MONGO_HOST || 'mongo'}/${config.db1}`).then(db => {
        logInfo('MongoDB 1 connected!');
        clans = db.collection('clans');
        players = db.collection('players');
        missed = db.collection('missed');
    }).catch(error => {
        logError('DB 1 connection error!');
        throw error;
    }),
    MongoClient.connect(`mongodb://${process.env.MONGO_HOST || 'mongo'}/${config.db2}`).then(db => {
        logInfo('MongoDB 2 connected!');
        tokens = db.collection('tokens');
        usersCommon = db.collection('users.common');
    }).catch(error => {
        logError('DB 2 connection error!');
        throw error;
    }),
    statUtils.getTanksList(),
    statUtils.loadTanksExpected()
]).then(() => start()).catch(e => {
    logError(JSON.stringify(e, utils.replaceErrors));
    throw e;
});

function start() {
    setInterval(async () => {
        try {
            await Promise.all([
                statUtils.getTanksList(),
                statUtils.loadTanksExpected()
            ]);
            console.log('wn8exp updated');
        } catch (e) {
            logError(`wn8exp update FAILED ${JSON.stringify(e, utils.replaceErrors)}`);
        }
    }, 3600000);
    config.updater.servers.forEach((server, serverIndex) => {
        const intensity = Math.ceil(1000 / (server.intensity || 0.25));

        serverQueues[server.region] = [];
        serverStats[server.region] = { success: 0, fail: 0 };
        setInterval(() => {
            performUpdate(server, serverIndex);
        }, intensity);
    });
}

async function performUpdate(server, serverIndex) {
    if (!serverLocks[serverIndex]) {
        try {
            serverLocks[serverIndex] = true;

            var queue = serverQueues[server.region];
            if (queue.length) {
                const playerIds = queue.splice(0, HTTP_BATCH_SIZE);
                updatePlayers(server, playerIds);
            }

            if (server.master && queue.length < PLAYERS_FETCH_THRESHOLD) {
                let lock = queueUpdateLocks[server.region];
                if (!lock || (lock == 'cooldown' && !queue.length)) {
                    let stats = serverStats[server.region];
                    if (stats.success > 0 || stats.fail > 0) {
                        msg = `${server.region} update stats: Success: ${stats.success}. Fail: ${stats.fail}`;
                        if (stats.dt)
                        {
                            msg += `. (${((stats.success + stats.fail) * 1000.0 / (new Date() - stats.dt)).toFixed(2)} pl/sec)`;
                        }
                        logInfo(msg);
                        if (stats.fail) {
                            logInfo(`Last error: ${JSON.stringify(stats.lastError)}`);
                        }
                        stats.success = 0;
                        stats.fail = 0;
                        stats.dt = new Date();
                    }
                }
                if (!lock) {
                    fetchUpdateClaims(server, serverIndex, PLAYER_POOL_SIZE - queue.length);
                }
            }
        }
        finally {
            serverLocks[serverIndex] = false;
        }
    }
}

async function fetchUpdateClaims(server, serverId, playersUpdateLimit) {
    if (queueUpdateLocks[server.region]) {
        return null;
    }
    queueUpdateLocks[server.region] = 'fetch';

    logInfo(`${server.region} Fetching queue`);

    const ranges = utils.getIdLimitsByRegion(config.updater.servers[serverId].region);
    const now = Date.now();
    const filters = [];

    _.forEach(ranges, ({ min, max }) => {
        filters.push({
                id: { $gte: min, $lt: max },
                postponed: { $lt: now },
                clan: { $exists: false }
            },
            {
                id: { $gte: min, $lt: max },
                postponed: { $exists: false },
                clan: { $exists: false }
            },
            {
                id: { $gte: min, $lt: max },
                postponed: { $lt: now },
                clan: false
            },
            {
                id: { $gte: min, $lt: max },
                postponed: { $exists: false },
                clan: false
            });
    });

    const countPlayers = await missed.find({ $or: filters }).count();
    const countPriority = await missed.find({ $and: [ { $or: filters }, { priority:true } ] }).count();
    const cursorPlayers = missed.find(
        { $or: filters }, { id: 1, retry: 1 })
        .sort({ priority: -1, ts: 1 })
        .limit(playersUpdateLimit);
    const playersQueue = serverQueues[server.region];

    try {
        const tasks = [];

        async function iterator(cursor) {
            for (let updateClaimDoc = await cursor.next(); updateClaimDoc !== null; updateClaimDoc = await cursor.next()) {
                if (updateClaimDoc.retry >= MAX_RETRIES) {
                    tasks.push(skipUpdate(updateClaimDoc.id, 'Too many retries'));
                    continue;
                }
                const retry = (updateClaimDoc.retry || 0) + 1;
                const postponed = now + postponeIntervals[retry - 1];
                const priority = !!+updateClaimDoc.priority;

                tasks.push(missed.update({ id: updateClaimDoc.id }, {
                    $set: {
                        retry,
                        postponed,
                        ts: now,
                        priority: priority
                    }
                }));

                playersQueue.push(updateClaimDoc.id);
            }
        }
        await iterator(cursorPlayers);
        logInfo(`${server.region} playersQueue length: ${playersQueue.length} (${countPlayers} total, ${countPriority} priority)`);
        await Promise.all(tasks);
    } catch (e) {
        queueUpdateLocks[server.region] = null;
        logError(`${server.region} something went wrong 1. ${JSON.stringify(e, utils.replaceErrors)}`);
        return null;
    }

    if (countPlayers < playersUpdateLimit) {
        queueUpdateLocks[server.region] = 'cooldown';
        logInfo(`No more update claims for server ${server.name}.... Cooldown`);
        setTimeout(() => {
            queueUpdateLocks[server.region] = null;
            logInfo(`Cooldown end for server ${server.name}`);
        }, 300 * 1000); // 5 min
        return null;
    }

    queueUpdateLocks[server.region] = null;
    logInfo(`${server.region} Fetched queue.`);
}

async function updatePlayers(server, playerIds) {
    if (!playerIds.length) {
        // TODO?
        logInfo(`${server.region} no players??? ${serverQueues[server.region]}`);
        return null;
    }

    try {
        const currentPlayerDocs = await players.find({ _id: { $in: playerIds } }, { v: 0 }).toArray();
        const playersHttpData = await httpUtils.getPlayers(playerIds, server, currentPlayerDocs);

        for (let stringId in playersHttpData.info) {
            const playerId = parseInt(stringId, 10);
            const playerCurrentDoc = _.find(currentPlayerDocs, { _id: playerId });
            const currentBattlesCount = _.get(playerCurrentDoc, 'b', 0);
            const player = playersHttpData.info[stringId];

            if (player === null && currentBattlesCount > 0) {
                await db.none('INSERT INTO xvm.hidestat (player_id, reason, comment)' +
                    ' VALUES ($1, \'gdpr_papi\', \'added by player updater\')' +
                    ' ON CONFLICT DO NOTHING', [ playerId ]);
                await skipUpdate(playerId, 'Maybe stat is hidden');
                serverStats[server.region].success++;
                continue;
            }

            if (_.get(player, 'statistics.random.battles', 0) === currentBattlesCount) {
                await skipUpdate(playerId, 'No battle count changed - common check');
                serverStats[server.region].success++;
                continue;
            }

            const playerVehicles = playersHttpData.tanks[stringId];
            const playerAchievements = (playersHttpData.achievements && playersHttpData.achievements[stringId]) || [ ];

            if (!playerVehicles) {
                await skipUpdate(playerId, 'No vehicles');
                serverStats[server.region].fail++;
                serverStats[server.region].lastError = { message: 'No vehicles', playerId };
                continue;
            }
            if (!player) continue;

            await db.none('DELETE FROM xvm.hidestat' +
                ' WHERE player_id=$1 AND reason=\'gdpr_papi\'', [ playerId ]);
            player.v = playerVehicles;
            // TODO remove
            player.old_v = playersHttpData.oldTanks && playersHttpData.oldTanks[stringId];
            player.achievements = playerAchievements;
            player.accountRating = playersHttpData.accountRating&& playersHttpData.accountRating[stringId];
            player.tanksRating = playersHttpData.tanksRating && playersHttpData.tanksRating[stringId];

            const newMemberHistory  = _.get(playersHttpData, `memberhistory.${stringId}`);
            player.memberhistory = _.compact(_.uniqBy(
                _.concat(_.get(playerCurrentDoc, 'memberhistory'), newMemberHistory),
                'joined_at'));

            const ID = Long.fromInt(playerId);
            const userCommonDocument = await usersCommon.findOne({ _id: ID });
            let playerDocument;

            if (_.get(player, 'statistics.random.battles', 0) > BATTLES_TRASH_HOLD || userCommonDocument) {
                playerDocument = await statUtils.createFromHttp(ID, player, missed, clans, playerCurrentDoc);

                if (playerDocument.b === currentBattlesCount) {
                    await skipUpdate(playerId, 'No battle count changed - vehicles check');
                    serverStats[server.region].success++;
                    continue;
                }
            } else if (currentBattlesCount > 0) {
                await players.remove({ _id: ID });
            }

            if (playerDocument) {
                // updating db
                const tokenDocument = await tokens.findOne({ _id: ID });
                const validToken = tokenDocument && (tokenDocument.expires_at > Date.now());

                if (validToken && tokenDocument.services &&
                    tokenDocument.services.flag !== 'default' &&
                    utils.checkCountryCode(tokenDocument.services.flag)) {
                    playerDocument.lang = tokenDocument.services.flag;
                    playerDocument.flag = tokenDocument.services.flag;
                } else {
                    switch (playerDocument.lang) {
                        case 'ru':
                            if (server.region === 'RU') {
                                playerDocument.lang = 'default';
                                playerDocument.flag = 'default';
                            }
                            break;
                        case 'en':
                            if (server.region === 'NA' || server.region === 'EU' || server.region === 'ASIA') {
                                playerDocument.lang = 'default';
                                playerDocument.flag = 'default';
                            }
                            break;
                        default:
                            playerDocument.flag = utils.getCountryCodeByLang(playerDocument.lang);
                    }
                }

                if (validToken) {
                    if (tokenDocument.services && tokenDocument.services.statBattle !== undefined) {
                        playerDocument.status = tokenDocument.services.statBattle ? 1 : 0;
                    } else {
                        playerDocument.status = 1;
                    }
                }

                // playerDocument.patreon = {
                //     isDonater: _.get(userCommonDocument, 'patreon.isDonater', false),
                //     currentDonate: _.get(userCommonDocument, 'patreon.currentDonate', 0),
                //     totalDonated: _.get(userCommonDocument, 'patreon.totalDonated', 0),
                // };

                // Statuses
                // undefined: no XVM user
                // 0: XVM user, no stat
                // 1: XVM stat user
                if (playerDocument.status === undefined && userCommonDocument) {
                    playerDocument.status = 0;
                }
                // 1015634
                await players.update({ _id: ID }, playerDocument, { upsert: true }).catch(error => {
                    logError("[ERROR] player update failed - " + error);
                });
            }

            await missed.remove({ id: playerId, clan: { $exists: false } });
            serverStats[server.region].success++;
        }
    } catch (e) {
        logError(`${server.region} something went wrong 2. ${JSON.stringify({
            e,
            playerIds
        }, utils.replaceErrors)}`);
        playerIds.forEach(async playerId => {
            await markProblemPlayer(playerId, {
                error: e
            }, server.region);
        });
        serverStats[server.region].fail++;
        serverStats[server.region].lastError = JSON.stringify({e, playerIds}, utils.replaceErrors);
        return null;
    }
}

function markProblemPlayer(playerId, reason) {
    return missed.update(
        { id: playerId },
        { $set: { reason } },
        { upsert: true });
}

function skipUpdate(claimId, reason) {
    const now = new Date();

    return Promise.all([
        missed.remove({ id: claimId }),
        players.update({ _id: claimId }, { $set: { ts: now.getTime(), dt: now, reason }}, { upsert: true })
    ]);
}
