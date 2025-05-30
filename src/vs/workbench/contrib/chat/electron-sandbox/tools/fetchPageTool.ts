/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { IWebContentExtractorService } from '../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { ITrustedDomainService } from '../../../url/browser/trustedDomainService.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolResult } from '../../common/languageModelToolsService.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';

export const InternalFetchWebPageToolId = 'vscode_fetchWebPage_internal';
export const FetchWebPageToolData: IToolData = {
	id: InternalFetchWebPageToolId,
	displayName: 'Fetch Web Page',
	tags: ['vscode_editing'],
	canBeReferencedInPrompt: true,
	toolReferenceName: 'fetch',
	modelDescription: localize('fetchWebPage.modelDescription', 'Fetches the main content from a web page. This tool is useful for summarizing or analyzing the content of a webpage.'),
	userDescription: localize('fetchWebPage.userDescription', 'Fetch the main content from a web page. You should include the URL of the page you want to fetch.'),
	inputSchema: {
		type: 'object',
		properties: {
			urls: {
				type: 'array',
				items: {
					type: 'string',
				},
				description: localize('fetchWebPage.urlsDescription', 'An array of URLs to fetch content from.')
			}
		},
		required: ['urls']
	}
};

export class FetchWebPageTool implements IToolImpl {
	private _alreadyApprovedDomains = new Set<string>();

	constructor(
		@IWebContentExtractorService private readonly _readerModeService: IWebContentExtractorService,
		@ITrustedDomainService private readonly _trustedDomainService: ITrustedDomainService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _token: CancellationToken): Promise<IToolResult> {
		const { valid } = this._parseUris((invocation.parameters as { urls?: string[] }).urls);
		if (!valid.length) {
			return {
				content: [{ kind: 'text', value: localize('fetchWebPage.noValidUrls', 'No valid URLs provided.') }]
			};
		}

		for (const uri of valid) {
			if (!this._trustedDomainService.isValid(uri)) {
				this._alreadyApprovedDomains.add(uri.toString(true));
			}
		}

		const result = await this._readerModeService.extract(valid);
		// Right now there's a bug when returning multiple text content parts so we're merging into one.
		// When that's fixed we can use the helper function _getPromptPartForWebPageContents.
		const value = result.map((content, index) => localize(
			'fetchWebPage.promptPart',
			'Below is the main content extracted from the webpage ({0}). Please read and analyze this content to assist with any follow-up questions:\n\n{1}',
			valid[index].toString(),
			content
		)).join('\n\n---\n\n');
		return { content: [{ kind: 'text', value }] };
	}

	async prepareToolInvocation(parameters: any, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const { invalid, valid } = this._parseUris(parameters.urls);
		const urlsNeedingConfirmation = valid.filter(url => !this._trustedDomainService.isValid(url) && !this._alreadyApprovedDomains.has(url.toString(true)));

		const pastTenseMessage = invalid.length
			? invalid.length > 1
				? new MarkdownString(
					localize(
						'fetchWebPage.pastTenseMessage.plural',
						'Fetched {0} web pages, but the following were invalid URLs:\n\n{1}\n\n', valid.length, invalid.map(url => `- ${url}`).join('\n')
					))
				: new MarkdownString(
					localize(
						'fetchWebPage.pastTenseMessage.singular',
						'Fetched web page, but the following was an invalid URL:\n\n{0}\n\n', invalid[0]
					))
			: new MarkdownString();
		pastTenseMessage.appendMarkdown(valid.length > 1
			? localize('fetchWebPage.pastTenseMessageResult.plural', 'Fetched {0} web pages', valid.length)
			: localize('fetchWebPage.pastTenseMessageResult.singular', 'Fetched [web page]({0})', valid[0].toString())
		);

		const result: IPreparedToolInvocation = {
			invocationMessage: valid.length > 1
				? new MarkdownString(localize('fetchWebPage.invocationMessage.plural', 'Fetching {0} web pages', valid.length))
				: new MarkdownString(localize('fetchWebPage.invocationMessage.singular', 'Fetching [web page]({0})', valid[0].toString())),
			pastTenseMessage
		};

		if (urlsNeedingConfirmation.length) {
			const confirmationTitle = urlsNeedingConfirmation.length > 1
				? localize('fetchWebPage.confirmationTitle.plural', 'Fetch untrusted web pages?')
				: localize('fetchWebPage.confirmationTitle.singular', 'Fetch untrusted web page?');

			const managedTrustedDomainsCommand = 'workbench.action.manageTrustedDomain';
			const confirmationMessage = new MarkdownString(
				urlsNeedingConfirmation.length > 1
					? urlsNeedingConfirmation.map(uri => `- ${uri.toString()}`).join('\n')
					: urlsNeedingConfirmation[0].toString(),
				{
					isTrusted: { enabledCommands: [managedTrustedDomainsCommand] },
					supportThemeIcons: true
				}
			);

			confirmationMessage.appendMarkdown(
				'\n\n$(info)' + localize(
					'fetchWebPage.confirmationMessageManageTrustedDomains',
					'You can [manage your trusted domains]({0}) to skip this confirmation in the future.',
					`command:${managedTrustedDomainsCommand}`
				)
			);

			result.confirmationMessages = { title: confirmationTitle, message: confirmationMessage };
		}

		return result;
	}

	private _parseUris(urls?: string[]): { invalid: string[]; valid: URI[] } {
		const invalidUrls: string[] = [];
		const validUrls: URI[] = [];
		urls?.forEach(uri => {
			try {
				const uriObj = URI.parse(uri);
				validUrls.push(uriObj);
			} catch (e) {
				invalidUrls.push(uri);
			}
		});

		return { invalid: invalidUrls, valid: validUrls };
	}

	// private _getPromptPartForWebPageContents(webPageContents: string, uri: URI): IToolResultTextPart {
	// 	return {
	// 		kind: 'text',
	// 		value: localize(
	// 			'fetchWebPage.promptPart',
	// 			'Below is the main content extracted from the webpage ({0}). Please read and analyze this content to assist with any follow-up questions:\n\n{1}',
	// 			uri.toString(),
	// 			webPageContents
	// 		)
	// 	};
	// }
}
