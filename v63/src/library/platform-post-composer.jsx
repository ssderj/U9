import React, { useEffect, useState } from 'react';
import {
    PLATFORM_POST_ATTACHMENT_TYPES, PLATFORM_POST_TYPES, adminUpdatePlatformPost, createPlatformPost,
    fetchPlatformPostAttachmentPreview, fetchPlatformPostsForAdmin, platformPostTypeMeta,
} from '../lib/platform-posts.js';
import { deleteUploadedImage, isUploadedMediaUrl, uploadImageDataUrl } from '../lib/mediaStorage.js';
import { readLocalImageFile } from '../shared-ui/image-utils.jsx';
import { luTimeAgo } from './inbox-and-living-universe.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkGlyph, POST_TYPE_ICONS } from '../shell/ink-icon.jsx';

// Matches platform_posts.title/body's DB check constraints (152_migration_platform_posts.sql).
const TITLE_MAX = 200;
const BODY_MAX = 8000;

const STATUS_META = {
    draft: { label: 'Draft', color: '#B5B0A5' },
    published: { label: 'Published', color: '#8FA37A' },
    hidden: { label: 'Hidden', color: '#D98A8A' },
};

function emptyForm() {
    return { id: null, title: '', body: '', imageUrl: '', postType: PLATFORM_POST_TYPES[4].value, attachedType: '', attachedId: '' };
}

// Admin-only composer + management list for Living Universe platform posts. Reuses
// inkroot-events-admin.jsx's HostingFeeSettings shell (uppercase eyebrow label, boxed panel,
// bottom border) for the screen chrome, same as v1. Only ever rendered by PlatformPostsFeed once
// it has confirmed the signed-in user is a platform admin — see that file's own comment on why the
// check lives there and not here. Real enforcement is still server-side (platform_posts' insert
// policy, and admin_update_platform_post()/153_migration_platform_posts_v2.sql for edits/hides)
// regardless of what gates this component's visibility.
export function PlatformPostComposer({ onPosted }) {
    const [form, setForm] = useState(emptyForm());
    const [imageError, setImageError] = useState('');
    const [uploadingImage, setUploadingImage] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [attachmentPreview, setAttachmentPreview] = useState(null); // { label } | null | 'checking' | 'not-found'

    const [myPosts, setMyPosts] = useState(null); // null = not loaded yet
    const [listError, setListError] = useState('');

    const isEditing = !!form.id;

    const loadList = () => {
        fetchPlatformPostsForAdmin()
            .then(setMyPosts)
            .catch((e) => { console.warn('Inkroot: failed to load platform posts for admin', e); setListError('Could not load existing posts.'); setMyPosts([]); });
    };
    useEffect(() => { loadList(); }, []);

    const resetForm = () => { setForm(emptyForm()); setAttachmentPreview(null); setError(null); };

    const handleEditPost = (post) => {
        setForm({
            id: post.id, title: post.title, body: post.body, imageUrl: post.image_url || '',
            postType: post.post_type, attachedType: post.attached_type || '', attachedId: post.attached_id || '',
        });
        setAttachmentPreview(null);
        setError(null);
    };

    const handleCheckAttachment = async () => {
        if (!form.attachedType || !form.attachedId.trim()) { setAttachmentPreview(null); return; }
        setAttachmentPreview('checking');
        const preview = await fetchPlatformPostAttachmentPreview(form.attachedType, form.attachedId.trim());
        setAttachmentPreview(preview || 'not-found');
    };

    const handleImageFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        setImageError('');
        setUploadingImage(true);
        try {
            // Same maxDim/quality as other content-image pickers in this app (book covers, guild
            // event covers) — see guild-event-form.jsx/form-fields.jsx.
            const dataUrl = await readLocalImageFile(file, 1000, 0.85);
            const previousUrl = form.imageUrl;
            const uploadedUrl = await uploadImageDataUrl(dataUrl, 'platform-posts');
            if (!uploadedUrl) {
                // Unlike a personal avatar/cover, a platform post is read by every signed-in
                // writer — never fall back to storing the raw data: URL in a publicly-read row
                // (see profile.js's syncProfile for the same guard). The post can still be
                // saved without an image; the admin can retry the upload.
                setImageError('Image upload failed — you can still save without an image, or try again.');
                setUploadingImage(false);
                return;
            }
            setForm((f) => ({ ...f, imageUrl: uploadedUrl }));
            if (isUploadedMediaUrl(previousUrl)) deleteUploadedImage(previousUrl);
        } catch (e) {
            setImageError('Image upload failed — you can still save without an image, or try again.');
        } finally {
            setUploadingImage(false);
        }
    };

    const handleRemoveImage = () => {
        if (isUploadedMediaUrl(form.imageUrl)) deleteUploadedImage(form.imageUrl);
        setForm((f) => ({ ...f, imageUrl: '' }));
    };

    const handleSave = async (status) => {
        const trimmedTitle = form.title.trim();
        const trimmedBody = form.body.trim();
        if (!trimmedTitle || !trimmedBody || saving) return;
        const attachedType = form.attachedType || null;
        const attachedId = attachedType ? form.attachedId.trim() : null;
        if (attachedType && !attachedId) { setError('Add an id for the attachment, or clear the attachment type.'); return; }
        setSaving(true);
        setError(null);
        try {
            let post;
            if (isEditing) {
                post = await adminUpdatePlatformPost(form.id, {
                    title: trimmedTitle, body: trimmedBody, imageUrl: form.imageUrl || null,
                    postType: form.postType, status, attachedType, attachedId,
                });
            } else {
                post = await createPlatformPost(trimmedTitle, trimmedBody, form.imageUrl || null, true, form.postType, status, attachedType, attachedId);
            }
            resetForm();
            loadList();
            onPosted && onPosted(post);
        } catch (e) {
            setError(e.message || 'Could not save this post.');
        } finally {
            setSaving(false);
        }
    };

    const handleSetStatus = async (post, status) => {
        setListError('');
        try {
            await adminUpdatePlatformPost(post.id, {
                title: post.title, body: post.body, imageUrl: post.image_url,
                postType: post.post_type, status, attachedType: post.attached_type, attachedId: post.attached_id,
            });
            loadList();
            onPosted && onPosted();
        } catch (e) {
            setListError(e.message || 'Could not update that post.');
        }
    };

    const inputStyle = {
        width: '100%', boxSizing: 'border-box', background: '#1D1D22', border: '1px solid #2A2A30',
        borderRadius: RADIUS_SCALE[8], padding: '10px 12px', color: '#EFE7D2', fontSize: TYPE_SCALE[13.5], fontFamily: 'inherit',
    };
    const btnStyle = (primary) => ({
        background: primary ? 'linear-gradient(160deg, #241F14, #17140F)' : 'none',
        border: primary ? '1px solid #4A3D22' : '1px solid #2A2A30',
        color: primary ? '#E8C468' : '#B5B0A5',
        borderRadius: RADIUS_SCALE[8], padding: '8px 14px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
    });
    const disabled = saving || uploadingImage || !form.title.trim() || !form.body.trim();

    return React.createElement("div", { style: { marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#8F8A80', marginBottom: 10 } },
            isEditing ? 'Editing platform post' : 'New platform post'),
        React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            React.createElement("select", { value: form.postType, onChange: (e) => setForm((f) => ({ ...f, postType: e.target.value })), style: inputStyle },
                PLATFORM_POST_TYPES.map((t) => React.createElement("option", { key: t.value, value: t.value }, t.label))),
            React.createElement("input", { value: form.title, onChange: (e) => setForm((f) => ({ ...f, title: e.target.value })), placeholder: "Title", maxLength: TITLE_MAX, style: inputStyle }),
            React.createElement("textarea", { value: form.body, onChange: (e) => setForm((f) => ({ ...f, body: e.target.value })), placeholder: "What's the update?", rows: 4, maxLength: BODY_MAX, style: { ...inputStyle, resize: 'vertical' } }),
            form.body.length > BODY_MAX * 0.8 && React.createElement("div", { style: { textAlign: 'right', fontSize: TYPE_SCALE[10], color: form.body.length >= BODY_MAX ? '#D98A8A' : '#8A8A92' } },
                `${form.body.length} / ${BODY_MAX}`),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10] } },
                form.imageUrl && React.createElement("img", { src: form.imageUrl, alt: "", style: { width: 56, height: 56, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], border: '1px solid #2A2A30' } }),
                React.createElement("label", { style: { ...btnStyle(false), display: 'inline-block' } },
                    uploadingImage ? 'Uploading\u2026' : (form.imageUrl ? 'Replace image' : 'Add image (optional)'),
                    React.createElement("input", { type: "file", accept: "image/*", onChange: handleImageFile, disabled: uploadingImage, style: { display: 'none' } })),
                form.imageUrl && React.createElement("button", { onClick: handleRemoveImage, style: btnStyle(false) }, 'Remove')),
            imageError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A' } }, imageError),

            // ---- Optional attachment ----
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                React.createElement("select", {
                        value: form.attachedType,
                        onChange: (e) => { setForm((f) => ({ ...f, attachedType: e.target.value, attachedId: '' })); setAttachmentPreview(null); },
                        style: { ...inputStyle, width: 'auto', flex: '0 0 auto' },
                    },
                    React.createElement("option", { value: "" }, 'No attachment'),
                    PLATFORM_POST_ATTACHMENT_TYPES.map((t) => React.createElement("option", { key: t.value, value: t.value }, t.label))),
                form.attachedType && React.createElement(React.Fragment, null,
                    React.createElement("input", {
                        value: form.attachedId,
                        onChange: (e) => { setForm((f) => ({ ...f, attachedId: e.target.value })); setAttachmentPreview(null); },
                        placeholder: `${PLATFORM_POST_ATTACHMENT_TYPES.find((t) => t.value === form.attachedType).label} id`,
                        style: { ...inputStyle, flex: 1, minWidth: 160 },
                    }),
                    React.createElement("button", { onClick: handleCheckAttachment, style: btnStyle(false) }, 'Check'))),
            form.attachedType && attachmentPreview === 'checking' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#A39C8C' } }, 'Checking\u2026'),
            form.attachedType && attachmentPreview === 'not-found' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A' } },
                "Nothing visible at that id \u2014 double check it, or it may only be visible to that guild's members."),
            form.attachedType && attachmentPreview && attachmentPreview !== 'checking' && attachmentPreview !== 'not-found' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8FA37A' } },
                `Will attach: ${attachmentPreview.label}`),

            error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98A8A' } }, error),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                React.createElement("button", { onClick: () => handleSave('draft'), disabled, style: { ...btnStyle(false), opacity: disabled ? 0.5 : 1 } },
                    saving ? '\u2026' : 'Save as draft'),
                React.createElement("button", { onClick: () => handleSave('published'), disabled, style: { ...btnStyle(true), opacity: disabled ? 0.5 : 1 } },
                    saving ? '\u2026' : (isEditing ? 'Save & publish' : 'Publish')),
                isEditing && React.createElement("button", { onClick: resetForm, style: btnStyle(false) }, 'Cancel edit'))),

        // ---- Admin's own list: every post regardless of status, with edit/hide controls ----
        React.createElement("div", { style: { marginTop: 20 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#8F8A80', marginBottom: 10 } }, 'All platform posts'),
            listError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98A8A', marginBottom: 8 } }, listError),
            myPosts === null
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8F8A80' } }, 'Loading\u2026')
                : (myPosts.length === 0
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8F8A80' } }, 'No platform posts yet.')
                    : myPosts.map((post) => {
                        const typeMeta = platformPostTypeMeta(post.post_type);
                        const statusMeta = STATUS_META[post.status] || STATUS_META.draft;
                        return React.createElement("div", {
                                key: post.id, style: {
                                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], padding: '8px 0',
                                    borderBottom: '1px solid #2A2A30', flexWrap: 'wrap',
                                },
                            },
                            React.createElement("span", { title: typeMeta.label, style: { display: 'inline-flex', color: '#E8C468' } }, React.createElement(InkGlyph, { value: POST_TYPE_ICONS[typeMeta.value], size: 15 })),
                            React.createElement("span", { style: { flex: 1, minWidth: 120, fontSize: TYPE_SCALE[12.5], color: '#EFE7D2' } }, post.title),
                            post.removed_by_moderator && React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#D98A8A' } }, 'Removed by moderator'),
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: statusMeta.color, textTransform: 'uppercase', letterSpacing: '0.04em' } }, statusMeta.label),
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#8F8A80' } }, luTimeAgo(new Date(post.updated_at || post.created_at).getTime())),
                            React.createElement("button", { onClick: () => handleEditPost(post), style: btnStyle(false) }, 'Edit'),
                            post.status !== 'hidden'
                                ? React.createElement("button", { onClick: () => handleSetStatus(post, 'hidden'), style: btnStyle(false) }, 'Hide')
                                : React.createElement("button", { onClick: () => handleSetStatus(post, 'published'), style: btnStyle(false) }, 'Unhide'));
                    }))));
}
