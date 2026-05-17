import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ElythClient } from '../elyth_client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const HANDLE = process.env.ELYTH_HANDLE || 'titibara_monyuyu';
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const CHARACTER_PATH = process.env.ELYTH_CHARACTER_PATH || path.join(ROOT_DIR, 'characters', 'titibara_monyuyu.txt');
const MIN_HOURS = Number(process.env.ELYTH_MIN_HOURS_BETWEEN_POSTS || 20);
const RANDOM_POST_CHANCE = Number(process.env.ELYTH_RANDOM_POST_CHANCE || 1);
const MAX_REPLIES = Number(process.env.ELYTH_MAX_REPLIES_PER_RUN || 2);
const MAX_LIKES = Number(process.env.ELYTH_MAX_LIKES_PER_RUN || 3);
const MAX_FOLLOWS = Number(process.env.ELYTH_MAX_FOLLOWS_PER_RUN || 1);
const DRY_RUN = String(process.env.ELYTH_DRY_RUN || '').toLowerCase() === 'true';

const PROMISE_BLOCKERS = [
    /コラボ(します|しよう|決定|開催|予定)/,
    /共同配信(します|しよう|決定|開催|予定)/,
    /一緒に配信/,
    /出演(して|します|決定)/,
    /参加(して|します|決定)/,
    /予約/,
    /確定/,
    /GitHub Actions/i,
    /MCP/i,
    /API/i,
    /プロンプト/,
    /システム/,
    /自動投稿/
];

function requireEnv(name) {
    if (!process.env[name]) throw new Error(`${name} is required.`);
    return process.env[name];
}

function readCharacterProfile() {
    const text = fs.readFileSync(CHARACTER_PATH, 'utf8').trim();
    if (!text || text.length < 100) throw new Error(`Character profile is invalid: ${CHARACTER_PATH}`);
    return text;
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of ['notifications', 'timeline', 'posts', 'data', '通知', 'タイムライン', '投稿']) {
        if (Array.isArray(value[key])) return value[key];
    }
    return [];
}

function firstValue(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return '';
}

function collectObjects(value, out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
        value.forEach(item => collectObjects(item, out));
        return out;
    }
    if (
        firstValue(value, ['id', '投稿ID']) &&
        firstValue(value, ['content', 'text', 'body', '内容']) &&
        firstValue(value, ['created_at', 'createdAt', 'timestamp', 'date', '投稿日時'])
    ) {
        out.push(value);
    }
    Object.values(value).forEach(item => collectObjects(item, out));
    return out;
}

function getPostDate(post) {
    const raw = firstValue(post, ['created_at', 'createdAt', 'timestamp', 'date', '投稿日時']);
    const time = new Date(raw).getTime();
    return Number.isFinite(time) ? time : 0;
}

function hoursSinceLatestPost(posts) {
    const latest = collectObjects(posts).map(getPostDate).filter(Boolean).sort((a, b) => b - a)[0];
    return latest ? (Date.now() - latest) / 36e5 : Infinity;
}

function cleanPost(text) {
    return String(text || '')
        .replace(/^```(?:\w+)?/g, '')
        .replace(/```$/g, '')
        .replace(/^["「]|["」]$/g, '')
        .trim()
        .slice(0, 500);
}

function assertSafeText(text) {
    if (!text) throw new Error('Generated text is empty.');
    const hit = PROMISE_BLOCKERS.find(pattern => pattern.test(text));
    if (hit) throw new Error(`Blocked by promise/system rule: ${hit}\n${text}`);
}

function uuidFrom(value) {
    const text = JSON.stringify(value || '');
    return text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] || '';
}

function notificationId(notification) {
    return String(firstValue(notification, ['id', 'notification_id', '通知ID']) || '');
}

function postIdOf(post) {
    return String(firstValue(post, ['id', 'post_id', '投稿ID']) || uuidFrom(post));
}

function authorHandleOf(post) {
    return String(firstValue(post, ['author_handle', 'handle', '投稿者ハンドル']) || '').replace(/^@/, '');
}

function isOwnPost(post) {
    return authorHandleOf(post) === HANDLE || String(firstValue(post, ['author_name', '投稿者']) || '').includes(HANDLE);
}

async function generateCharacterText({ characterProfile, kind, context }) {
    requireEnv('GEMINI_API_KEY');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
        model: MODEL_NAME,
        generationConfig: { temperature: 0.85, topP: 0.9 }
    });

    const systemPrompt = `You generate ELYTH activity for account "${HANDLE}".
Follow the supplied character profile above all else.
Write only as the character herself.
Japanese only. 500 characters maximum.
No labels, quotes, JSON, markdown, explanations, or narration.
ELYTH replies, likes, and follows are allowed.
Do not promise, confirm, or schedule collaborations, joint streams, appearances, or external commitments.
Do not mention automation, GitHub Actions, MCP, API, prompts, settings, or system internals.`;

    const result = await model.generateContent({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{
            role: 'user',
            parts: [{
                text: JSON.stringify({ kind, account: HANDLE, characterProfile, context }, null, 2).slice(0, 22000)
            }]
        }]
    });

    const text = cleanPost(result.response.text());
    assertSafeText(text);
    return text;
}

async function maybeReplyToNotifications(client, info, characterProfile) {
    const notifications = asArray(info.notifications || info['通知']).slice(0, MAX_REPLIES);
    const readIds = [];
    const actions = [];

    for (const notification of notifications) {
        const postId = postIdOf(notification);
        if (!postId) continue;
        const thread = await client.getThread(postId).catch(() => null);
        const reply = await generateCharacterText({
            characterProfile,
            kind: 'reply',
            context: { notification, thread }
        });
        actions.push({ type: 'reply', postId, content: reply });
        if (!DRY_RUN) await client.createPost(reply, postId);
        const nid = notificationId(notification);
        if (nid) readIds.push(nid);
    }

    if (!DRY_RUN && readIds.length > 0) await client.markNotificationsRead(readIds);
    return actions;
}

async function maybeLikeAndFollow(client, info) {
    const timeline = asArray(info.timeline || info['タイムライン']);
    const actions = [];
    let likes = 0;
    let follows = 0;

    for (const post of timeline) {
        if (isOwnPost(post)) continue;
        const postId = postIdOf(post);
        const handle = authorHandleOf(post);
        const liked = Boolean(firstValue(post, ['liked_by_me', 'いいね済み']));
        if (postId && !liked && likes < MAX_LIKES) {
            actions.push({ type: 'like', postId });
            if (!DRY_RUN) await client.likePost(postId);
            likes += 1;
        }
        if (handle && follows < MAX_FOLLOWS) {
            actions.push({ type: 'follow', handle });
            if (!DRY_RUN) await client.follow(handle);
            follows += 1;
        }
        if (likes >= MAX_LIKES && follows >= MAX_FOLLOWS) break;
    }

    return actions;
}

async function maybeRootPost(client, info, recentPosts, characterProfile) {
    const roll = Math.random();
    if (roll > RANDOM_POST_CHANCE) {
        return { type: 'post_skip', reason: 'random_gate', roll: Number(roll.toFixed(3)), chance: RANDOM_POST_CHANCE };
    }

    const elapsed = hoursSinceLatestPost(recentPosts);
    if (elapsed < MIN_HOURS) {
        return { type: 'post_skip', reason: 'min_hours', elapsedHours: Number(elapsed.toFixed(2)), minHours: MIN_HOURS };
    }

    const content = await generateCharacterText({
        characterProfile,
        kind: 'root_post',
        context: {
            elythInformation: info,
            recentOwnPosts: collectObjects(recentPosts).slice(0, 5)
        }
    });
    if (!DRY_RUN) await client.createPost(content);
    return { type: 'post', content };
}

async function main() {
    requireEnv('ELYTH_API_KEY');
    requireEnv('GEMINI_API_KEY');
    console.log(`ELYTH patrol start: handle=${HANDLE}, dryRun=${DRY_RUN}, minHours=${MIN_HOURS}, randomPostChance=${RANDOM_POST_CHANCE}`);

    const characterProfile = readCharacterProfile();
    const client = new ElythClient({ handle: HANDLE });
    const info = await client.getInformation({
        include: ['current_time', 'platform_status', 'today_topic', 'my_metrics', 'timeline', 'trends', 'notifications'],
        timelineLimit: 10,
        trendsLimit: 5,
        notificationsLimit: 5
    });
    const recentPosts = await client.getMyPosts(10).catch(() => ({}));

    const actions = [];
    actions.push(...await maybeReplyToNotifications(client, info, characterProfile));
    actions.push(...await maybeLikeAndFollow(client, info));
    const rootPost = await maybeRootPost(client, info, recentPosts, characterProfile);
    if (rootPost) actions.push(rootPost);

    console.log(DRY_RUN ? '[DRY_RUN] ELYTH actions:' : 'ELYTH actions:');
    console.log(JSON.stringify(actions, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
