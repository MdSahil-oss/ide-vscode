/* SPDX-License-Identifier: BSD-3-Clause */

import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Hover,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	isCFile,
	isKraftfile,
	validateFile
} from './utils';

import { kraftfileCompletionItems } from './kraftfile/complete';
import { readdirSync } from 'fs';
import { cCompletionItems } from './c/complete';
import { getKraftfileHoverItem } from './kraftfile/hover';

// **************Main file for LSP server implementation**************

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;
let hasUnikraftDir: boolean = false;
let workspaceDir: string = '';
let currentUriText: string = '';
let workspaceUnikraftConfig: any = undefined;
let enabledCCompletion: boolean = false;
let includePath: string[] = [];

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: [`"`, `#`],
			},
			hoverProvider: true,
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(async () => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
	isUnikraftDirExistInWorkspace();
	initGlobalVars();
});

// The settings interface
interface Settings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultServerSettings: Settings = { maxNumberOfProblems: 100 };
let globalServerSettings: Settings = defaultServerSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<Settings>> = new Map();

connection.onDidChangeConfiguration(async change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings.
		documentSettings.clear();
	} else {
		globalServerSettings = <Settings>(
			(change.settings.unikraft.server || defaultServerSettings)
		);
	}

	initGlobalVars();

	// Revalidate all open text documents.
	documents.all().forEach(((element) => {
		const diagnostics = validateFile(element, enabledCCompletion);
		if (diagnostics !== undefined) {
			connection.sendDiagnostics({ uri: element.uri, diagnostics: diagnostics });
		}
	}));
});

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

documents.onDidOpen(e => {
	currentUriText = e.document.getText();
	validate(e.document);
})

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(e => {
	currentUriText = e.document.getText();
	validate(e.document);
});

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
// onCompletion runs on every type until a list of completion items is returned.
connection.onCompletion(
	(params: TextDocumentPositionParams): CompletionItem[] => {
		switch (true) {
			case isKraftfile(params.textDocument.uri):
				return kraftfileCompletionItems();

			case enabledCCompletion && isCFile(params.textDocument.uri):
				if (!hasUnikraftDir) {
					return [];
				}

				return cCompletionItems(currentUriText, params, workspaceDir, includePath);
		}
		return [];
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return item;
	}
);

// Runs for hover action.
connection.onHover((params: TextDocumentPositionParams): Hover | undefined => {
	const docUri = params.textDocument.uri;

	switch (true) {
		case isKraftfile(docUri):
			return getKraftfileHoverItem(currentUriText, params);

		// Add more cases for diffrent files below.
	}
})

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

// getDocumentSettings() returns settings for a specific workspace document.
function getDocumentSettings(resource: string): Thenable<Settings> | any {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalServerSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = getWorkspaceServerConfig(resource);
	}
	return result;
}

// getWorkspaceServerConfig() returns workspace `unikraft.server` configuration.
export function getWorkspaceServerConfig(resource: string): any {
	if (
		workspaceUnikraftConfig && workspaceUnikraftConfig["server"]
	) {
		let result = workspaceUnikraftConfig["server"];
		documentSettings.set(resource, Promise.resolve(result));
		return result;
	}
	return globalServerSettings;
}

// validate() validates the files supported by extension.
async function validate(document: TextDocument) {
	let settings = await getDocumentSettings(document.uri);
	if (settings == null) {
		settings = getWorkspaceServerConfig(document.uri);
	}

	if (isCFile(document.uri) && !hasUnikraftDir) {
		return;
	}

	if (hasDiagnosticRelatedInformationCapability) {
		const diagnostics = validateFile(document, enabledCCompletion);
		if (diagnostics !== undefined) {
			connection.sendDiagnostics({ uri: document.uri, diagnostics: diagnostics.slice(0, settings.maxNumberOfProblems + 1) });
		}
	}
}

// isUnikraftDirExistInWorkspace() Checks if `$PWD/.unikraft/` dir exist.
function isUnikraftDirExistInWorkspace() {
	connection.workspace.getWorkspaceFolders().then((res): any => {
		if (res === null) {
			hasUnikraftDir = false;
			return;
		}
		workspaceDir = res[0].uri.slice(res[0].uri.lastIndexOf('//') + 1);
		hasUnikraftDir = readdirSync(workspaceDir).includes('.unikraft');
	});
	return;
}

// initGlobalVars() initialises the global variables `workspaceUnikraftConfig` & `enabledCCompletion`.
async function initGlobalVars() {
	// Fetching workspace configuration.
	let workspaceSettings = await connection.workspace.getConfiguration();

	if (workspaceSettings && workspaceSettings["unikraft"]) {
		workspaceUnikraftConfig = workspaceSettings["unikraft"]
	}

	// Checking the value of `enableCCompletion` in workspace configuration.
	if (workspaceUnikraftConfig && workspaceUnikraftConfig["enableCCompletion"]) {
		enabledCCompletion = true;
		if (
			workspaceSettings["C_Cpp"] &&
			workspaceSettings["C_Cpp"]["default"] &&
			workspaceSettings["C_Cpp"]["default"]["includePath"]
		) {
			const tmpPaths: string[] = workspaceSettings["C_Cpp"]["default"]["includePath"];
			tmpPaths.forEach((path, index) => {
				if (path.endsWith("**")) {
					path = path.slice(0, path.lastIndexOf("**"));
				}
				includePath[index] = path;
			})
		}
	} else {
		enabledCCompletion = false;
	}
}
