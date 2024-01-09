import { OutputChannel, StatusBarItem } from 'vscode';
import { Command } from './Command';
import {
    getProjectPath,
    showErrorMessage,
    getSourcesDir,
    getManifestsDir,
    getTarget,
    showInfoMessage
} from './utils';

export async function kraftClean(
    kraftChannel: OutputChannel,
    kraftStatusBarItem: StatusBarItem,
) {
    kraftChannel.show(true);
    const projectPath = getProjectPath();
    if (!projectPath) {
        showErrorMessage(kraftChannel, kraftStatusBarItem, 'Clean error: No workspace.');
        return;
    }
    showInfoMessage(kraftChannel, kraftStatusBarItem,
        "Cleaning project..."
    )
    cleanFromYaml(kraftChannel, kraftStatusBarItem, projectPath);
}

async function cleanFromYaml(
    kraftChannel: OutputChannel,
    kraftStatusBarItem: StatusBarItem,
    projectPath: string
) {
    const target = await getTarget(
        kraftChannel,
        kraftStatusBarItem,
        projectPath
    );
    if (!target) {
        showErrorMessage(kraftChannel, kraftStatusBarItem, 'Clean error: No target chosen.');
        return;
    }
    const splitTarget = target.split('-');
    const sourcesDir = getSourcesDir();
    const manifestsDir = getManifestsDir();
    const command = new Command(
        `kraft clean --log-type=json -p ${splitTarget[0]} -m ${splitTarget[1]}`,
        {
            cwd: projectPath,
            env: Object.assign(process.env, {
                'KRAFTKIT_PATHS_MANIFESTS': manifestsDir,
                'KRAFTKIT_PATHS_SOURCES': sourcesDir,
                'KRAFTKIT_NO_CHECK_UPDATES': true
            }),
        },
        'Cleaned project.',
        () => { }
    );

    try {
        command.execute(kraftChannel, kraftStatusBarItem);
    } catch (error) {
        showErrorMessage(kraftChannel, kraftStatusBarItem,
            `[Error] Clean project ${error}.`
        )
    }
}
