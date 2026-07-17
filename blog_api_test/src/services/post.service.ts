'use strict';
import { db } from '../db/database.js';

export function getPostsByAuthor(authorId: string) {
  return db.prepare(`
    SELECT * FROM posts WHERE author_id = ? ORDER BY published_at DESC
  `).all(authorId);
}

export function createPost(data: { title: string; content: string; authorId: string }) {
  const postId = uuidv4();
  db.prepare(`
    INSERT INTO posts (id, title, content, author_id)
    VALUES (?, ?, ?, ?)
  `).run(postId, data.title, data.content, data.authorId);

  return getPost(postId);
}

export function getPost(id: string) {
  return db.prepare(`
    SELECT p.*, u.username as author_name FROM posts p
    LEFT JOIN users u ON p.author_id = u.id WHERE p.id = ?
  `).get(id);
}

export function deletePost(id: string) {
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
}

export function getComments(postId: string) {
  return db.prepare(`
    SELECT * FROM comments WHERE post_id = ? ORDER BY created_at DESC
  `).all(postId);
}

export function createComment(data: { postId: string; content: string; authorId: string }) {
  const commentId = uuidv4();
  db.prepare(`
    INSERT INTO comments (id, post_id, author_id, content)
    VALUES (?, ?, ?, ?)
  `).run(commentId, data.postId, data.authorId, data.content);

  return { id: commentId, ...data };
}

export function deleteComment(commentId: string) {
  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
}

export function getPostWithComments(postId: string) {
  const post = getPost(postId);
  if (!post) return null;

  const comments = getComments(postId);
  return { ...post, comments };
}