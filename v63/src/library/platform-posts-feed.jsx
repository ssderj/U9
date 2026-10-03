import React, { useEffect, useState } from 'react';
import { currentUser } from '../lib/supabaseClient.js';
import { fetchIsPlatformAdmin } from '../lib/moderation.js';
import {
    addPlatformPostComment, fetchPlatformPostAttachmentPreview, fetchPlatformPostComments, fetchPlatformPosts,
    platformPostTypeMeta, togglePlatformPostReaction,
} from '../lib/platform-posts.js';
import { FIRESIDE_REACTIONS } from '../guild/guild-hall.jsx';
import { luTimeAgo } from './inbox-and-living-universe.jsx';
import { PlatformPostComposer } from './platform-post-composer.jsx';
import { ReportButton } from '../shared-ui/report-content-modal.jsx';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { useSync } from '../shell/sync-context.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { withIcon, InkGlyph, POST_TYPE_ICONS } from '../shell/ink-icon.jsx';

const COMMENT_MAX = 8000;

// A post's optional Book/Guild/World/Event attachment, rendered as a small chip. Resolved through
// fetchPlatformPostAttachmentPreview — the SAME RLS-scoped read any signed-in reader already gets
// — so a post attached to a guild-only book or a Guild World Bible entry this particular reader
// can't see just renders nothing here, never a title or name the reader wasn't already allowed to
// see. See that function's own comment in lib/platform-posts.js.
function PlatformPostAttachmentChip({ attachedType, attachedId }) {
    const [preview, setPreview] = useState(null);
    useEffect(() => {
        let cancelled = false;
        if (!attachedType || !attachedId) { setPreview(null); return; }
        fetchPlatformPostAttachmentPreview(attachedType, attachedId).then((p) => { if (!cancelled) setPreview(p); });
        return () => { cancelled = true; };
    }, [attachedType, attachedId]);
    if (!preview) return null;
    const kindLabel = { book: 'Book', guild: 'Guild', world: 'World', event: 'Event' }[attachedType] || 'Attached';
    return React.createElement("div", {
            style: {
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], marginBottom: 10,
                background: 'rgba(232,196,104,0.08)', border: '1px solid rgba(232,196,104,0.25)',
                borderRadius: RADIUS_SCALE[999], padding: '3px 10px', fontSize: TYPE_SCALE[11], color: '#E8C468',
            },
        },
        React.createElement("span", { style: { textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: TYPE_SCALE[9.5], opacity: 0.75 } }, kindLabel),
        preview.label);
}

// One post's reaction bar + comment thread. Reuses FiresideMessage's reaction-bar pattern
// (fireside-board.jsx) as a visual/structural reference — same pill-button-per-reaction shape,
// same FIRESIDE_REACTIONS set (imported read-only, not duplicated) — but comments are their own
// table (platform_post_comments) rather than fireside's self-referencing parent_id replies, so
// they're fetched and listed separately instead of being filtered out of the same flat array.
function PlatformPostCard({ post, myReactions, onToggleReaction }) {
    const [showComments, setShowComments] = useState(false);
    const [comments, setComments] = useState(null); // null = not loaded yet
    const [commentDraft, setCommentDraft] = useState('');
    const [commentPosting, setCommentPosting] = useState(false);
    const [commentError, setCommentError] = useState('');
    const typeMeta = platformPostTypeMeta(post.post_type);

    const loadComments = () => {
        fetchPlatformPostComments(post.id)
            .then(setComments)
            .catch((e) => { console.warn('Inkroot: failed to load platform post comments', e); setComments([]); });
    };

    const handleToggleComments = () => {
        const next = !showComments;
        setShowComments(next);
        if (next && comments === null) loadComments();
    };

    const handleSubmitComment = () => {
        const text = commentDraft.trim();
        if (!text || commentPosting) return;
        setCommentPosting(true);
        setCommentError('');
        addPlatformPostComment(post.id, text)
            .then(() => { setCommentDraft(''); loadComments(); })
            .catch((e) => setCommentError(e.message || "Your comment didn't send — try again."))
            .finally(() => setCommentPosting(false));
    };

    return React.createElement("div", { style: {
            background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[12],
            padding: '16px 18px', marginBottom: 14,
        } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#E8C468', marginBottom: 6, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } },
            React.createElement("span", { style: { display: 'inline-flex' } }, React.createElement(InkGlyph, { value: POST_TYPE_ICONS[typeMeta.value], size: 13 })), React.createElement("span", { style: { textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: TYPE_SCALE[9.5], opacity: 0.8 } }, typeMeta.label)),
        React.createElement("div", { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: SPACE_SCALE[8], marginBottom: 6 } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#E8C468' } }, post.title),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#9A958B', flexShrink: 0 } }, luTimeAgo(new Date(post.created_at).getTime()))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#9A958B', marginBottom: 10, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } },
            post.author_name || 'Inkroot',
            post.author_verified && React.createElement("span", { title: "Verified account", style: { color: '#7FB08F' } }, '\u2713')),
        post.image_url && React.createElement("img", { src: post.image_url, alt: "", style: { width: '100%', borderRadius: RADIUS_SCALE[8], marginBottom: 10, display: 'block' } }),
        post.attached_type && React.createElement(PlatformPostAttachmentChip, { attachedType: post.attached_type, attachedId: post.attached_id }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], lineHeight: 1.6, color: '#EFE7D2', whiteSpace: 'pre-wrap', marginBottom: 12 } }, post.body),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', alignItems: 'center' } },
            FIRESIDE_REACTIONS.map((r) => React.createElement("button", {
                    key: r.key, onClick: () => onToggleReaction(post.id, r.key, myReactions.has(r.key)), title: r.label,
                    style: {
                        background: myReactions.has(r.key) ? 'rgba(232,196,104,0.18)' : 'none',
                        border: '1px solid rgba(232,196,104,0.3)', borderRadius: RADIUS_SCALE[999], minWidth: 44, padding: '0 12px', minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[13], cursor: 'pointer', color: '#E8C468',
                    },
                }, r.icon)),
            React.createElement("button", { onClick: handleToggleComments, style: {
                    background: 'none', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[999], padding: '0 14px', gap: 6, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[11], cursor: 'pointer', color: '#B5B0A5',
                } }, withIcon('chat', `${showComments ? 'Hide' : 'Comments'}${comments ? ` (${comments.length})` : ''}`, 14)),
            React.createElement(ReportButton, {
                contentType: "platform_post", contentId: post.id,
                buttonStyle: { background: 'none', border: '1px solid #3A2A2A', color: '#B08585', borderRadius: RADIUS_SCALE[999], padding: '0 14px', minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[11], cursor: 'pointer' },
            })),
        showComments && React.createElement("div", { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid #2A2A30' } },
            comments === null
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8F8A80' } }, 'Loading comments\u2026')
                : (comments.length === 0
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8F8A80', marginBottom: 10 } }, 'No comments yet.')
                    : comments.map((c) => React.createElement("div", { key: c.id, style: { marginBottom: 10 } },
                        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginBottom: 2 } },
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#EFE7D2' } }, c.author_name || 'Writer'),
                            c.author_verified && React.createElement("span", { title: "Verified account", style: { color: '#7FB08F', fontSize: TYPE_SCALE[10.5] } }, '\u2713'),
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#8F8A80' } }, luTimeAgo(new Date(c.created_at).getTime())),
                            React.createElement(ReportButton, {
                                contentType: "platform_post_comment", contentId: c.id, label: "",
                                buttonStyle: { background: 'none', border: 'none', color: '#B08585', fontSize: TYPE_SCALE[11], cursor: 'pointer', minWidth: 44, minHeight: 44, padding: 0, margin: '-14px -10px -14px 0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
                            })),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#B5B0A5', whiteSpace: 'pre-wrap' } }, c.body)))),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 6 } },
                React.createElement("input", {
                    value: commentDraft, onChange: (e) => setCommentDraft(e.target.value), placeholder: "Write a comment\u2026", maxLength: COMMENT_MAX,
                    onKeyDown: (e) => e.key === 'Enter' && handleSubmitComment(),
                    style: { flex: 1, borderRadius: RADIUS_SCALE[8], border: '1px solid #2A2A30', background: '#1D1D22', color: '#EFE7D2', minHeight: 44, boxSizing: 'border-box', padding: '0 12px', fontSize: TYPE_SCALE[12.5] },
                }),
                React.createElement("button", { onClick: handleSubmitComment, disabled: commentPosting, style: {
                        background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: commentPosting ? '#8F8A80' : '#E8C468',
                        borderRadius: RADIUS_SCALE[8], minHeight: 44, minWidth: 56, padding: '0 14px', fontSize: TYPE_SCALE[12], cursor: commentPosting ? 'default' : 'pointer',
                    } }, commentPosting ? '\u2026' : 'Post')),
            commentError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginTop: 4 } }, commentError)));
}

// New section on the Living Universe screen (fix 4) — admin-posted platform updates, visible to
// every signed-in writer. Determines admin standing for the composer itself, via the same
// fetchIsPlatformAdmin() ink-root.jsx already uses to gate the Inkroot Events admin entry point —
// avoids threading an isPlatformAdmin prop down through home-screen.jsx/living-universe-screen.jsx
// just for this one section. Real enforcement is still server-side (platform_posts' own insert
// policy, and admin_update_platform_post() for edits/hides) regardless of what this check shows,
// same caveat as every other admin gate in this app. fetchPlatformPosts() itself is always
// published-only now (v2) — see that function's own comment for why that's enforced client-side
// too, not just left to RLS.
export function PlatformPostsFeed() {
    const sync = useSync();
    const isSignedIn = !!(sync && sync.session);
    const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
    const [posts, setPosts] = useState(null); // null while loading
    const [reactionsByPost, setReactionsByPost] = useState({});
    const [loadError, setLoadError] = useState('');

    const load = () => {
        fetchPlatformPosts()
            .then(({ posts: p, reactionsByPost: r }) => { setPosts(p); setReactionsByPost(r); })
            .catch((e) => { console.warn('Inkroot: failed to load platform posts', e); setLoadError('Could not load platform updates.'); setPosts([]); });
    };

    useEffect(() => {
        if (!isSignedIn) { setPosts([]); return; }
        load();
        currentUser().then((u) => { if (u) fetchIsPlatformAdmin(u.id).then(setIsPlatformAdmin).catch(() => setIsPlatformAdmin(false)); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSignedIn]);

    const myUserIdRef = React.useRef(null);
    useEffect(() => { currentUser().then((u) => { myUserIdRef.current = u ? u.id : null; }); }, [isSignedIn]);

    const handleToggleReaction = (postId, key, active) => {
        togglePlatformPostReaction(postId, key, active).then(load).catch((e) => console.warn('Inkroot: platform post reaction failed', e));
    };

    const myReactionsFor = (postId) => {
        const rows = reactionsByPost[postId] || [];
        return new Set(rows.filter((r) => r.user_id === myUserIdRef.current).map((r) => r.reaction));
    };

    return React.createElement("div", { className: "lu-section" },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 4 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#E8C468', letterSpacing: '0.08em', textTransform: 'uppercase' } }, 'Platform Updates')),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#9A958B', marginBottom: 16 } }, "News and announcements from Inkroot."),
        !isSignedIn
            ? React.createElement(EmptyState, { text: "Sign in to see platform updates and join the conversation." })
            : React.createElement(React.Fragment, null,
                isPlatformAdmin && React.createElement(PlatformPostComposer, { onPosted: load }),
                loadError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98A8A', marginBottom: 10 } }, loadError),
                posts === null
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#8F8A80' } }, 'Loading\u2026')
                    : (posts.length === 0
                        ? React.createElement(EmptyState, { text: "No platform updates yet — check back soon." })
                        : posts.map((post) => React.createElement(PlatformPostCard, {
                            key: post.id, post, myReactions: myReactionsFor(post.id), onToggleReaction: handleToggleReaction,
                        })))));
}
