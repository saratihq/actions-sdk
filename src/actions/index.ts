/**
 * The SDK's action + trigger catalog.
 *
 * A few actions double as canonical examples, one per framework capability:
 *  - slack.send_channel_message — dynamic dropdown (live picker), managed transport
 *  - slack.list_channels        — cursor pagination, managed transport
 *  - github.list_issues         — Link-header pagination, direct transport, apiKey scheme
 *  - slack.new_message          — webhook trigger (app-level: handshake + signature + transform)
 *  - github.new_push            — registered webhook trigger (onEnable/onDisable + signature)
 *  - slack.new_channel          — polling trigger (dedup)
 *
 * The no-auth utility apps need no credential, run in-process, and work offline
 * (`http, text, date, math, json, xml, csv, crypto, data_mapper, graphql,
 * hackernews, binance, pdf, qrcode`, plus the markdown/HTML, JSONata, XLSX and
 * XML-parse actions folded into the existing apps). Polling triggers
 * (`http.new_item`, `hackernews.new_story`, `rss.new_item`) run over the SDK's
 * polling framework.
 */
export * as slack from './slack';
export * as github from './github';
export * as jira from './jira';
export * as linear from './linear';
export * as stripe from './stripe';
export * as airtable from './airtable';
export * as calendly from './calendly';
export * as salesforce from './salesforce';
export * as intercom from './intercom';
export * as mailchimp from './mailchimp';
export * as zendesk from './zendesk';
export * as hubspot from './hubspot';
export * as gmail from './gmail';
export * as notion from './notion';
export * as sheets from './sheets';
export * as docs from './docs';
export * as drive from './drive';
export * as slides from './slides';
export * as calendar from './calendar';
export * as asana from './asana';
export * as clickup from './clickup';
export * as todoist from './todoist';
export * as dropbox from './dropbox';
export * as typeform from './typeform';
export * as zoom from './zoom';
export * as outlook from './outlook';
export * as ai from './ai';
// No-auth utility apps.
export * as http from './http';
export * as text from './text';
export * as date from './date';
export * as math from './math';
export * as json from './json';
export * as xml from './xml';
export * as csv from './csv';
export * as crypto from './crypto';
export * as data_mapper from './data-mapper';
export * as graphql from './graphql';
export * as hackernews from './hackernews';
export * as binance from './binance';
export * as pdf from './pdf';
export * as qrcode from './qrcode';
export * as rss from './rss';

import { newChannel, newMessage } from './slack';
import { getFile, listChannels, sendChannelMessage, uploadFile } from './slack';
import { listIssues, newIssue, newPullRequest, newPush } from './github';
import { jiraActions } from './jira';
import { linearActions } from './linear';
import { stripeActions } from './stripe';
import { airtableActions } from './airtable';
import { calendlyActions } from './calendly';
import { salesforceActions } from './salesforce';
import { intercomActions } from './intercom';
import { mailchimpActions } from './mailchimp';
import { zendeskActions } from './zendesk';
import { hubspotActions } from './hubspot';
import { gmailActions } from './gmail';
import { notionActions } from './notion';
import { sheetsActions } from './sheets';
import { docsActions } from './docs';
import { driveActions } from './drive';
import { slidesActions } from './slides';
import { calendarActions } from './calendar';
import { asanaActions } from './asana';
import { clickupActions } from './clickup';
import { todoistActions } from './todoist';
import { dropboxActions } from './dropbox';
import { typeformActions } from './typeform';
import { zoomActions } from './zoom';
import { outlookActions } from './outlook';
import { aiActions } from './ai';
// Utility apps: action arrays + polling triggers.
import { httpActions, newItem as httpNewItem } from './http';
import { textActions } from './text';
import { dateActions } from './date';
import { mathActions } from './math';
import { jsonActions } from './json';
import { xmlActions } from './xml';
import { csvActions } from './csv';
import { cryptoActions } from './crypto';
import { dataMapperActions } from './data-mapper';
import { graphqlActions } from './graphql';
import { hackernewsActions, newStory as hackernewsNewStory } from './hackernews';
import { binanceActions } from './binance';
import { pdfActions } from './pdf';
import { qrcodeActions } from './qrcode';
import { newItem as rssNewItem } from './rss';
// Registered-webhook triggers on the app catalog (aliased — `newIssue`/`newTask`/etc. collide across apps).
import { newCustomer as stripeNewCustomer, paymentSucceeded as stripePaymentSucceeded } from './stripe';
import { newResponse as typeformNewResponse } from './typeform';
import { newInvitee as calendlyNewInvitee } from './calendly';
import { newIssue as linearNewIssue } from './linear';
import { newTask as clickupNewTask } from './clickup';
// Polling triggers on the app catalog (aliased for the same reason).
import { newSubscriber as mailchimpNewSubscriber } from './mailchimp';
import { newIssue as jiraNewIssue } from './jira';
import { newTask as asanaNewTask } from './asana';
import { newTask as todoistNewTask } from './todoist';
import { newContact as hubspotNewContact } from './hubspot';
import { newConversation as intercomNewConversation } from './intercom';
import { newTicket as zendeskNewTicket } from './zendesk';
import { newRecord as salesforceNewRecord } from './salesforce';
import { newRecord as airtableNewRecord } from './airtable';
import { newPage as notionNewPage } from './notion';
import { newFile as dropboxNewFile } from './dropbox';
import { newFile as driveNewFile } from './drive';
import { newRow as sheetsNewRow } from './sheets';
import { newRecording as zoomNewRecording } from './zoom';
import { newEvent as calendarNewEvent } from './calendar';
import { newEmail as outlookNewEmail } from './outlook';
import { newEmail as gmailNewEmail } from './gmail';

/** The canonical example triggers. */
export const referenceTriggers = [newMessage, newChannel, newPush, newIssue, newPullRequest] as const;

/**
 * The no-auth utility actions, grouped for discoverability. These need no
 * credential (`none` scheme), run in-process, and work offline.
 */
export const utilityActions = [
  ...httpActions,
  ...textActions,
  ...dateActions,
  ...mathActions,
  ...jsonActions,
  ...xmlActions,
  ...csvActions,
  ...cryptoActions,
  ...dataMapperActions,
  ...graphqlActions,
  ...hackernewsActions,
  ...binanceActions,
  ...pdfActions,
  ...qrcodeActions,
];

/**
 * Every registered polling trigger, flattened for catalog projection + runtime
 * registration — the polling counterpart of {@link catalogActions}. A consumer
 * projects each via `.toManifest()` (same path the action registry uses) and
 * drives one poll via `.runPoll({ auth, props, store })`; the SDK returns only
 * events unseen since the stored cursor (watermark + bounded dedup set).
 */
export const pollingTriggers = [
  newChannel,
  httpNewItem,
  hackernewsNewStory,
  rssNewItem,
  mailchimpNewSubscriber,
  jiraNewIssue,
  asanaNewTask,
  todoistNewTask,
  hubspotNewContact,
  intercomNewConversation,
  zendeskNewTicket,
  salesforceNewRecord,
  airtableNewRecord,
  notionNewPage,
  dropboxNewFile,
  driveNewFile,
  sheetsNewRow,
  zoomNewRecording,
  calendarNewEvent,
  outlookNewEmail,
  gmailNewEmail,
] as const;

/**
 * Every registered-webhook trigger on the app catalog — the `onEnable`/`verify`/
 * `onDisable` lifecycle. The example webhook triggers ({@link referenceTriggers}
 * minus the polling `newChannel`) plus the app triggers registered per-app.
 */
export const appWebhookTriggers = [
  stripePaymentSucceeded,
  stripeNewCustomer,
  typeformNewResponse,
  calendlyNewInvitee,
  linearNewIssue,
  clickupNewTask,
] as const;

/**
 * Every trigger the SDK ships — webhook + polling — for a unified catalog build.
 * `slack.new_message` is deliberately excluded: it is an app-level webhook (Slack
 * Events) that needs an app-level intake (url_verification handshake + app-level
 * signing secret + event→workflow routing) the host runtime does not yet provide,
 * so registering it would ship an unreachable trigger. Its definition is kept
 * ready in {@link referenceTriggers} for example and live-test use until that
 * intake exists.
 */
export const catalogTriggers = [newPush, newIssue, newPullRequest, ...appWebhookTriggers, ...pollingTriggers];

/**
 * The full catalog — every app's actions, flattened for catalog builds and
 * provider registration.
 */
export const catalogActions = [
  sendChannelMessage,
  listChannels,
  listIssues,
  getFile,
  uploadFile,
  ...jiraActions,
  ...linearActions,
  ...stripeActions,
  ...airtableActions,
  ...calendlyActions,
  ...salesforceActions,
  ...intercomActions,
  ...mailchimpActions,
  ...zendeskActions,
  ...hubspotActions,
  ...gmailActions,
  ...notionActions,
  ...sheetsActions,
  ...docsActions,
  ...driveActions,
  ...slidesActions,
  ...calendarActions,
  ...asanaActions,
  ...clickupActions,
  ...todoistActions,
  ...dropboxActions,
  ...typeformActions,
  ...zoomActions,
  ...outlookActions,
  ...aiActions,
  ...utilityActions,
];
