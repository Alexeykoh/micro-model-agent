'use strict';
import { db, initDb } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';

export function registerUser(data: { username: string; email: string; password: string }) {
  const hashedPassword = bcrypt.hashSync(data.password, 10);
  const userId = uuidv4();

  db.prepare(`
    INSERT INTO users (id, username, email, password)
    VALUES (?, ?, ?, ?)
  `).run(userId, data.username, data.email, hashedPassword);

  return { id: userId, username: data.username, email: data.email };
}

export function loginUser(data: { email: string; password: string }) {
  const user = db.prepare(`
    SELECT * FROM users WHERE email = ?
  `).get(data.email);

  if (!user) throw new Error('Пользователь не найден');

  const validPassword = bcrypt.compareSync(data.password, user.password);
  if (!validPassword) throw new Error('Неверный пароль');

  return { id: user.id, username: user.username };
}

export function getPosts(authorId?: string) {
  if (authorId) {
    return db.prepare(`
      SELECT * FROM posts WHERE author_id = ? ORDER BY published_at DESC
    `).all(authorId);
  }
  return db.prepare('SELECT * FROM posts ORDER BY published_at DESC').all();
}

export function getPost(id: string) {
  return db.prepare(`
    SELECT * FROM posts WHERE id = ?
  `).get(id);
}

export function createPost(data: { title: string; content: string; authorId: string }) {
  const postId = uuidv4();
  db.prepare(`
    INSERT INTO posts (id, title, content, author_id)
    VALUES (?, ?, ?, ?)
  `).run(postId, data.title, data.content, data.authorId);

  return getPost(postId);
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
