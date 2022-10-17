const core = require('@actions/core');
const fs = require('fs');
const { IncomingWebhook } = require('ms-teams-webhook');

const ARTIFACT = 'notify.json';

async function run() {
    try {
        const hook = core.getInput('hook', { required: true });
        const alerts = JSON.parse(core.getInput('alerts', { required: true }));
        const commit_oid = core.getInput('commit_oid', { required: true });
        let notify_cache = {};

        if (fs.existsSync(ARTIFACT)) {
            notify_cache = JSON.parse(fs.readFileSync(ARTIFACT));
        }

        const webhook = new IncomingWebhook(hook);
        const toSend = [];

        for (let alert of alerts) {
            if (alert.state === 'open') {
                if (!notify_cache[alert.number]) {
                    notify_cache[alert.number] = true;
                    toSend.push({
                        '@type': 'MessageCard',
                        '@context': 'https://schema.org/extensions',
                        'summary': 'New security alert found',
                        'themeColor': '0075FF',
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
                                        'name': 'Commit Found In:',
                                        'value': `[${commit_oid}](https://github.com/iBat/codeql-test/commit/${commit_oid})`
                                    },
                                ]
                            }
                        ]
                    });
                }
            }
        }

        if (toSend.length) {
            await webhook.send(JSON.stringify(toSend));
        }
        fs.writeFileSync(ARTIFACT, JSON.stringify(notify_cache));
    } catch (error) {
        core.setFailed(`analyze action failed: ${error}`);
        console.log(error);
    }
}

run();
