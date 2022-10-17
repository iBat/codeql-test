const core = require('@actions/core');
const fs = require('fs');
const { IncomingWebhook } = require('@slack/webhook');

const ARTIFACT = 'notify.json';

async function run() {
    try {
        const hook = core.getInput('hook', { required: true });
        const alerts = JSON.parse(core.getInput('alerts', { required: true }));
        const commit_oid = core.getInput('commit_oid', { required: true });
        let notify_cache = {};

        if (fs.existsSync(ARTIFACT)) {
            notify_cache = JSON.parse(fs.readFileSync(ARTIFACT));
            console.log(`CACHED: ${notify_cache}`);
        }

        const webhook = new IncomingWebhook(hook);

        for (let alert of alerts) {
            if (alert.state === 'open') {
                if (!notify_cache[alert.number]) {
                    notify_cache[alert.number] = true;
                    await webhook.send({
                        text: `A Code Scanning alert from ${alert.tool.name} has just been found and created. Information about the alert can be found below.`,
                        attachments: [
                            {
                                color: "danger",
                                title: `${alert.rule.id}`,
                                title_link: `${alert.html_url}`,
                                fields: [
                                    {
                                        title: "Rule ID",
                                        value: `${alert.rule.id}`,
                                        short: true,
                                    },
                                    {
                                        title: "Rule Description",
                                        value: `${alert.rule.description}`,
                                        short: true,
                                    },
                                    {
                                        title: "Alert Severity:",
                                        value: `${alert.rule.severity}`,
                                        short: true,
                                    },
                                    {
                                        title: "Commit Found In:",
                                        value: `${commit_oid}`,
                                        short: true,
                                    },
                                ],
                            },
                        ]
                    });
                }
            }
        }

        console.log(notify_cache);
        fs.writeFileSync(ARTIFACT, JSON.stringify(notify_cache));
    } catch (error) {
        core.setFailed(`analyze action failed: ${error}`);
        console.log(error);
    }
}

run();
