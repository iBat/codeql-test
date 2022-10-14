import * as core from '@actions/core';

async function run() {
    try {
        const alerts = core.getInput('alerts', { required: true });

        console.log(alerts);
    } catch (error) {
        core.setFailed(`analyze action failed: ${error}`);
        console.log(error);
    }
}

run();
