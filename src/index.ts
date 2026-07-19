#!/usr/bin/env node

/**
 * Точка входа CLI.
 * Создаёт CLI и запускает парсинг аргументов.
 *
 * @module index
 */

import { createCli } from './cli.js';

const cli = createCli();
cli.parse(process.argv);
