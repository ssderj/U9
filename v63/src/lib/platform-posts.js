import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames, fetchVerifiedIds } from './profile.js';
import { sanitizeError } from './errors.js';

// Admin-only posts on the Living Universe page — see 152_migration_platform_posts.sql and
// 153_migration_platform_posts_v2.sql. Cloned from library-guild.js's fireside section
// (fetchFiresidePosts / postFiresideMessage / toggleFiresideReaction), with the guild-membership
// plumbing (ensureFounderGuildMembership, per-guild realtime channels) dropped: platform_posts has
// no guild_id, so there's no membership race to guard and no per-guild scoping to do.
// library-guild.js itself is untouched.

// The six Living Universe post categories (153_migration_platform_posts_v2.sql's
// platform_posts_post_type_check) — single source of truth for both the composer's picker and the
// feed's badge, so the two can never drift.
export const PLATFORM_POST_TYPES = [
  { value: 'book_spotlight', emoji: '\uD83D\uDCD6', label: 'New Book Spotlight' },
  { value: 'worldbuilding_showcase', emoji: '\uD83C\uDF0D', label: 'Worldbuilding Showcase' },
  { value: 'guild_announcement', emoji: '\uD83C\uDFF0', label: 'Guild Announcement' },
  { value: 'writing_tip', emoji: '\u270D\uFE0F', label: 'Writing Tip' },
  { value: 'inkroot_update', emoji: '\uD83D\uDCF0', label: 'Inkroot Update' },
  { value: 'event_announcement', emoji: '\uD83C\uDF89', label: 'Event Announcement' },
];
export function platformPostTypeMeta(value) {
  return PLATFORM_POST_TYPES.find((t) => t.value === value) || PLATFORM_POST_TYPES[4];
}

// The four attachment kinds a post can optionally point at (153's attached_type check).
export const PLATFORM_POST_ATTACHMENT_TYPES = [
  { value: 'book', label: 'Book' },
  { value: 'guild', label: 'Guild' },
  { value: 'world', label: 'World (Guild World Bible entry)' },
  { value: 'event', label: 'Guild Event' },
];

// Resolves an attachment to a short display label, or null if there's nothing to show — either
// because there's no attachment, or because the id doesn't resolve to a row the CURRENT viewer is
// allowed to see. This always queries as the signed-in viewer, through the same RLS every other
// read in the app goes through — it never elevates access, so a post attached to a guild-only
// book or a Guild World Bible entry the reader isn't a member of safely renders as "no preview"
// rather than leaking the referenced content's title to someone who couldn't otherwise see it.
// 'book' checks published_books first (the common, Inkroot-wide case), then falls back to
// guild_published_books, since a platform post's attached_id doesn't record which of the two
// tables it came from and the two id spaces don't collide (see 153's own column comment).
export async function fetchPlatformPostAttachmentPreview(attachedType, attachedId) {
  if (!attachedType || !attachedId) return null;
  try {
    if (attachedType === 'book') {
      const { data: pb } = await supabase.from('published_books').select('id, title').eq('id', attachedId).maybeSingle();
      if (pb) return { type: attachedType, id: attachedId, label: pb.title };
      const { data: gpb } = await supabase.from('guild_published_books').select('id, title').eq('id', attachedId).maybeSingle();
      return gpb ? { type: attachedType, id: attachedId, label: gpb.title } : null;
    }
    if (attachedType === 'guild') {
      const { data } = await supabase.from('player_guilds').select('id, name').eq('id', attachedId).maybeSingle();
      return data ? { type: attachedType, id: attachedId, label: data.name } : null;
    }
    if (attachedType === 'world') {
      const { data } = await supabase.from('guild_order_world_entries').select('id, title').eq('id', attachedId).maybeSingle();
      return data ? { type: attachedType, id: attachedId, label: data.title } : null;
    }
    if (attachedType === 'event') {
      const { data } = await supabase.from('guild_events').select('id, title').eq('id', attachedId).maybeSingle();
      return data ? { type: attachedType, id: attachedId, label: data.title } : null;
    }
  } catch (e) {
    console.warn('Inkroot: platform post attachment preview lookup failed', e);
  }
  return null;
}

const POST_COLUMNS = 'id, title, body, image_url, author_id, created_at, updated_at, post_type, status, attached_type, attached_id';

async function withAuthorNames(rawPosts) {
  const authorIds = (rawPosts || []).map((p) => p.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return (rawPosts || []).map((p) => ({ ...p, author_name: names[p.author_id], author_verified: verifiedIds.has(p.author_id) }));
}

async function withReactionsAndComments(posts) {
  const postIds = posts.map((p) => p.id);
  const reactionsByPost = {};
  const commentCountByPost = {};
  if (postIds.length > 0) {
    const [{ data: reactions, error: reactErr }, { data: comments, error: commentCountErr }] = await Promise.all([
      supabase.from('platform_post_reactions').select('post_id, user_id, reaction').in('post_id', postIds),
      supabase.from('platform_post_comments').select('post_id').in('post_id', postIds),
    ]);
    if (reactErr) throw sanitizeError(reactErr);
    if (commentCountErr) throw sanitizeError(commentCountErr);
    for (const r of reactions || []) {
      if (!reactionsByPost[r.post_id]) reactionsByPost[r.post_id] = [];
      reactionsByPost[r.post_id].push(r);
    }
    for (const c of comments || []) {
      commentCountByPost[c.post_id] = (commentCountByPost[c.post_id] || 0) + 1;
    }
  }
  return { posts, reactionsByPost, commentCountByPost };
}

// The public Living Universe feed's fetch — always published-only, regardless of who's asking.
// This is on top of (not instead of) the RLS policy: a platform admin's own SELECT would also be
// allowed to see their drafts/hidden posts (see "platform admins read all platform posts",
// 153_migration_platform_posts_v2.sql), but the Feed itself should never mix an admin's
// in-progress draft into the same list a regular reader sees, even when the admin is the one
// looking at it. Draft/hidden posts are only ever shown in the admin management list below.
export async function fetchPlatformPosts() {
  const { data: rawPosts, error: postsErr } = await supabase
    .from('platform_posts')
    .select(POST_COLUMNS)
    .eq('status', 'published')
    .order('created_at', { ascending: false });
  if (postsErr) throw sanitizeError(postsErr);
  const posts = await withAuthorNames(rawPosts);
  return withReactionsAndComments(posts);
}

// Event announcements published in the last `days` days, for the Author Inbox's System Announcements
// tab (only this post type goes there for now - the rest stay in the Living Universe feed). Same
// published-only rule as fetchPlatformPosts above, on top of RLS. Returns null when signed out, so the
// caller can tell "nothing to show" ([]) from "couldn't ask" and never prunes on the latter.
export async function fetchRecentEventAnnouncements(days = 30) {
  const user = await currentUser();
  if (!user) return null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('platform_posts')
    .select('id, title, body, created_at')
    .eq('status', 'published')
    .eq('removed_by_moderator', false)
    .eq('post_type', 'event_announcement')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw sanitizeError(error);
  return data || [];
}

// Admin management view — every post regardless of status, for the composer's own post list.
// RLS ("platform admins read all platform posts") is what actually restricts this to admins; a
// non-admin calling it just gets back the same published-only set fetchPlatformPosts already
// gives them (their own drafts/hidden ones too, if they happen to have authored any before losing
// admin standing — same "author always sees their own" shape as everything else here).
export async function fetchPlatformPostsForAdmin() {
  const { data: rawPosts, error: postsErr } = await supabase
    .from('platform_posts')
    .select(POST_COLUMNS)
    .order('created_at', { ascending: false });
  if (postsErr) throw sanitizeError(postsErr);
  return withAuthorNames(rawPosts);
}

// Admin-only — platform_posts' own insert policy (152_migration_platform_posts.sql) rejects this
// for anyone without profiles.is_platform_admin, so this throws a clear error up front rather
// than letting the request round-trip to Supabase just to be rejected by RLS. imageUrl should
// already be a short uploaded URL (see mediaStorage.js's uploadImageDataUrl with the
// 'platform-posts' folder) — never a raw data: URL, matching syncProfile's same guard in
// profile.js, since this row is read by every signed-in writer. status/postType/attachment are
// new in v2 — status is explicit here (never relies on the column's 'draft' default) so the
// composer's own "Save as draft" vs "Publish" choice is always what actually lands.
export async function createPlatformPost(title, body, imageUrl, isPlatformAdmin, postType, status, attachedType, attachedId) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to post.');
  if (!isPlatformAdmin) throw new Error('Only Inkroot admins can post here.');
  const safeImageUrl = imageUrl && imageUrl.startsWith('data:') ? null : (imageUrl || null);
  const { data, error } = await supabase.from('platform_posts').insert({
    title,
    body,
    image_url: safeImageUrl,
    author_id: user.id,
    post_type: postType,
    status,
    attached_type: attachedType || null,
    attached_id: attachedId || null,
  }).select(POST_COLUMNS).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Any platform admin editing (or hiding) ANY post — including one authored by a different admin —
// goes through admin_update_platform_post() (153_migration_platform_posts_v2.sql), never a direct
// table update. "Hide" is just this same call with status: 'hidden'; there's no separate delete —
// platform posts are never hard-deleted, so their comments/reactions/report history survive.
export async function adminUpdatePlatformPost(postId, { title, body, imageUrl, postType, status, attachedType, attachedId }) {
  const safeImageUrl = imageUrl && imageUrl.startsWith('data:') ? null : (imageUrl || null);
  const { data, error } = await supabase.rpc('admin_update_platform_post', {
    p_id: postId,
    p_title: title,
    p_body: body,
    p_image_url: safeImageUrl,
    p_post_type: postType,
    p_status: status,
    p_attached_type: attachedType || null,
    p_attached_id: attachedId || null,
  });
  if (error) throw sanitizeError(error);
  return data;
}

export async function togglePlatformPostReaction(postId, reaction, currentlyActive) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to react.');
  if (currentlyActive) {
    const { error } = await supabase.from('platform_post_reactions').delete().eq('post_id', postId).eq('user_id', user.id).eq('reaction', reaction);
    if (error) throw sanitizeError(error);
  } else {
    const { error } = await supabase.from('platform_post_reactions').insert({ post_id: postId, user_id: user.id, reaction });
    if (error) throw sanitizeError(error);
  }
}

export async function fetchPlatformPostComments(postId) {
  const { data: rawComments, error } = await supabase
    .from('platform_post_comments')
    .select('id, post_id, author_id, body, created_at')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });
  if (error) throw sanitizeError(error);

  const authorIds = (rawComments || []).map((c) => c.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return (rawComments || []).map((c) => ({ ...c, author_name: names[c.author_id], author_verified: verifiedIds.has(c.author_id) }));
}

export async function addPlatformPostComment(postId, body) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to comment.');
  const { data, error } = await supabase.from('platform_post_comments').insert({
    post_id: postId,
    author_id: user.id,
    body,
  }).select().single();
  if (error) throw sanitizeError(error);
  return data;
}
