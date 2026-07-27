# Privacy Policy for Blackboard Search Extension

Last updated: July 19, 2026

Blackboard Search Extension helps users search Blackboard resources that they can already access in their logged-in browser and optional resource packs they deliberately install.

## Data stored locally

The extension stores the Blackboard search index, installed optional resource-pack content, settings, and optional API configuration in Chrome storage on the user's device.

Optional resource packs are installed only after the user enters a registered pack command and the extension confirms an active Blackboard session. Pack metadata and prepared searchable text remain in local Chrome storage unless the user asks an API-powered question, as described below.


## Blackboard session verification

Before Blackboard indexing or optional pack installation, the extension makes a credentialed request to the configured Blackboard site in the user's browser. It uses the response URL and page shape to determine whether the session appears authenticated or has been redirected to sign-in.

The extension does not read or store the user's Blackboard password. Browser cookies and credentials remain governed by Chrome and are sent only to the Blackboard site as part of that verification request.

## Data sent to API providers

If a user configures an API provider and asks an API-powered question, the extension sends the user's question and a bounded set of candidate excerpts from indexed Blackboard resources or optional resource packs to that provider. The provider selects relevant evidence before answering. When evidence appears incomplete or the question requires careful policy interpretation, the extension may send additional bounded excerpts from provider-nominated parent documents. The selected evidence is then used for answer generation and citation validation or repair. Providers may include OpenAI, OpenRouter, or DeepSeek, depending on the user's setup.

The full local index is not sent to the provider. Each request contains a bounded subset of indexed text, and one user question may require multiple provider calls for planning, evidence selection, answer generation, and validation or repair.

## Feedback

If a user opens the feedback form, information they choose to submit is sent to the linked form provider.

## Data not collected by us

We do not operate a server for this extension, do not sell user data, and do not use indexed content for advertising.

## Contact

For privacy questions, contact the publisher email listed in the Chrome Web Store listing.
