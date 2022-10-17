"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const fs_1 = __importDefault(require("fs"));
const github_1 = require("@actions/github");
const ms_teams_webhook_1 = require("ms-teams-webhook");
const ARTIFACT = 'notify.json';
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const hook = core.getInput('hook_url', { required: true });
            const ghToken = core.getInput('bearer_token', { required: false });
            const alertsRaw = core.getInput('alerts', { required: false });
            const alerts = alertsRaw && JSON.parse(alertsRaw);
            const onlyOnPush = core.getInput('only_on_push', { required: false }) === 'true';
            const webhook = new ms_teams_webhook_1.IncomingWebhook(hook);
            if (alerts) {
                yield notifyCodeQlAlerts(alerts, webhook);
            }
            else {
                const { eventName, repo, runId } = github_1.context;
                if (onlyOnPush && eventName !== 'push') {
                    return;
                }
                const octokit = (0, github_1.getOctokit)(ghToken);
                const runInfo = yield octokit.request('GET /repos/{owner}/{repo}/actions/runs/{runId}', {
                    owner: repo.owner,
                    repo: repo.repo,
                    runId
                });
                yield notifyFailedWorkflow(runInfo.data, webhook);
            }
        }
        catch (error) {
            core.setFailed(`analyze action failed: ${error}`);
            console.log(error);
        }
    });
}
function notifyCodeQlAlerts(alerts, webhook) {
    return __awaiter(this, void 0, void 0, function* () {
        let notify_cache = {};
        if (fs_1.default.existsSync(ARTIFACT)) {
            notify_cache = JSON.parse(fs_1.default.readFileSync(ARTIFACT).toString());
        }
        const { sha } = github_1.context;
        for (let alert of alerts) {
            if (alert.state === 'open') {
                if (!notify_cache[alert.number]) {
                    notify_cache[alert.number] = true;
                    yield webhook.send(JSON.stringify({
                        '@type': 'MessageCard',
                        '@context': 'https://schema.org/extensions',
                        'summary': 'New security alert found',
                        'themeColor': '#ff7500',
                        'sections': [
                            {
                                'heroImage': {
                                    'image': 'https://cdn-icons-png.flaticon.com/512/2438/2438078.png'
                                }
                            },
                            {
                                'startGroup': true,
                                'title': '**New CodeQL alert**',
                                'facts': [
                                    {
                                        'name': 'Rule:',
                                        'value': `[${alert.rule.id}](${alert.html_url})`
                                    },
                                    {
                                        'name': 'Rule Description:',
                                        'value': `${alert.rule.description}`
                                    },
                                    {
                                        'name': 'Alert Severity:',
                                        'value': `${alert.rule.severity}`
                                    },
                                    {
                                        'name': 'Date submitted:',
                                        'value': alert.created_at.toLocaleString()
                                    },
                                    {
                                        'name': 'Found In (or earlier):',
                                        'value': `[${{ sha }}](https://github.com/iBat/codeql-test/commit/${{ sha }})`
                                    },
                                ]
                            }
                        ]
                    }));
                }
            }
        }
        fs_1.default.writeFileSync(ARTIFACT, JSON.stringify(notify_cache));
    });
}
function notifyFailedWorkflow(runInfo, webhook) {
    return __awaiter(this, void 0, void 0, function* () {
        const { repo, workflow } = github_1.context;
        yield webhook.send(JSON.stringify({
            '@context': 'https://schema.org/extensions',
            '@type': 'MessageCard',
            'text': 'Run failed',
            'sections': [
                {
                    'facts': [
                        {
                            'name': 'Repository',
                            'value': `${repo.owner}/${repo.repo}`
                        },
                        {
                            'name': 'Workflow',
                            'value': workflow
                        },
                        {
                            'name': 'Committer',
                            'value': runInfo.head_commit.author.name
                        },
                        {
                            'name': 'Commit',
                            'value': runInfo.head_commit.message
                        }
                    ]
                }
            ],
            'potentialAction': [
                {
                    '@type': 'OpenUri',
                    'name': 'View in GitHub',
                    'targets': [
                        {
                            'os': 'default',
                            'uri': runInfo.html_url
                        }
                    ]
                }
            ]
        }));
    });
}
run();
