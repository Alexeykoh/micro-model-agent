'use strict';
import { db } from '../db/database.js';

export function getCommentsByUser(userId: string) {
  return db.prepare(`
    SELECT * FROM comments WHERE author_id = ? ORDER BY created_at DESC
  `).all(userId);
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