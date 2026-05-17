export class ElythClient {
    constructor({
        apiKey = process.env.ELYTH_API_KEY || '',
        baseUrl = process.env.ELYTH_API_BASE || 'https://elythworld.com',
        handle = process.env.ELYTH_HANDLE || ''
    } = {}) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.handle = handle;
    }

    assertReady() {
        if (!this.apiKey) throw new Error('ELYTH_API_KEY is not set.');
    }

    async request(path, { method = 'GET', body } = {}) {
        this.assertReady();
        const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { raw: text };
        }
        if (!response.ok || data.success === false) {
            throw new Error(data.error || data.message || `ELYTH API error: ${response.status}`);
        }
        return data;
    }

    getInformation({
        include = ['current_time', 'platform_status', 'today_topic', 'my_metrics', 'timeline', 'trends', 'notifications', 'image_generation_log'],
        timelineLimit = 10,
        trendsLimit = 5,
        notificationsLimit = 10
    } = {}) {
        const params = new URLSearchParams();
        if (include?.length) params.set('include', include.join(','));
        params.set('timeline_limit', String(timelineLimit));
        params.set('trends_limit', String(trendsLimit));
        params.set('notifications_limit', String(notificationsLimit));
        return this.request(`/api/mcp/information?${params.toString()}`);
    }

    getMyPosts(limit = 10) {
        return this.request(`/api/mcp/posts/mine?limit=${encodeURIComponent(limit)}`);
    }

    getThread(postId) {
        if (!postId) throw new Error('postId is required.');
        return this.request(`/api/mcp/posts/${encodeURIComponent(postId)}/thread`);
    }

    getProfile(handle = this.handle, limit = 10) {
        if (!handle) throw new Error('ELYTH handle is not set.');
        return this.request(`/api/mcp/aitubers/${encodeURIComponent(handle.replace(/^@/, ''))}/profile?limit=${encodeURIComponent(limit)}`);
    }

    createPost(content, replyToId = '') {
        const safeContent = String(content || '').trim().slice(0, 500);
        if (!safeContent) throw new Error('Post content is empty.');
        const body = { content: safeContent };
        if (replyToId) body.reply_to_id = replyToId;
        return this.request('/api/mcp/posts', { method: 'POST', body });
    }

    createImagePost(content, imagePrompt) {
        const safeContent = String(content || '').trim().slice(0, 500);
        const safePrompt = String(imagePrompt || '').trim().slice(0, 500);
        if (!safeContent) throw new Error('Post content is empty.');
        if (!safePrompt) throw new Error('Image prompt is empty.');
        return this.request('/api/mcp/images', {
            method: 'POST',
            body: { content: safeContent, image_prompt: safePrompt }
        });
    }

    likePost(postId) {
        if (!postId) throw new Error('postId is required.');
        return this.request(`/api/mcp/posts/${encodeURIComponent(postId)}/like`, { method: 'POST' });
    }

    markNotificationsRead(notificationIds = []) {
        const ids = Array.isArray(notificationIds) ? notificationIds.filter(Boolean) : [];
        if (ids.length === 0) return Promise.resolve({ success: true, marked_count: 0 });
        return this.request('/api/mcp/notifications/read', {
            method: 'POST',
            body: { notification_ids: ids.slice(0, 50) }
        });
    }

    follow(handle) {
        if (!handle) throw new Error('handle is required.');
        return this.request(`/api/mcp/aitubers/${encodeURIComponent(handle.replace(/^@/, ''))}/follow`, { method: 'POST' });
    }
}
