import { createConnection } from 'mysql2/promise';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';

const identifier = name => '`' + name.replaceAll('`', '``') + '`';
export async function connectDatabase(values) {
  const url = new URL(values.DATABASE_URL);
  if (url.protocol !== 'mysql:' || !/^\/[A-Za-z0-9_$-]+$/.test(url.pathname)) throw Error('不支持的数据库连接配置');
  return createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, multipleStatements: false });
}
export async function queryDatabase(sql, values) {
  const db = await connectDatabase(values);
  try { const [rows] = await db.query(sql); return String(Object.values(rows[0] || {})[0] ?? ''); } finally { await db.end(); }
}
export async function dumpDatabase(path, values) {
  const db = await connectDatabase(values), output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const finished = new Promise((ok, bad) => { output.once('finish', ok); output.once('error', bad); }); finished.catch(() => {});
  const write = async text => { if (!output.write(text)) await once(output, 'drain'); };
  try {
    const [tables] = await db.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
    if (tables.some(table => table.ENGINE !== 'InnoDB')) throw Error('数据库包含非事务表，不能创建一致性备份');
    await db.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    await write("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET TIME_ZONE='+00:00';\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n");
    await db.query("SET TIME_ZONE='+00:00'");
    for (const table of tables) {
      const name = identifier(table.TABLE_NAME), [ddl] = await db.query('SHOW CREATE TABLE ' + name);
      await write('DROP TABLE IF EXISTS ' + name + ';\n' + ddl[0]['Create Table'] + ';\n');
      const [columns] = await db.query('SHOW COLUMNS FROM ' + name);
      const names = columns.filter(column => !/GENERATED/.test(column.Extra)).map(column => column.Field);
      const stream = db.connection.query('SELECT ' + names.map(identifier).join(',') + ' FROM ' + name).stream({ highWaterMark: 32 });
      for await (const row of stream) {
        const values = names.map(key => { const value = row[key]; if (value === null) return 'NULL'; if (typeof value === 'number') return String(value); return "X'" + (Buffer.isBuffer(value) ? value : Buffer.from(String(value))).toString('hex') + "'"; });
        await write('INSERT INTO ' + name + ' (' + names.map(identifier).join(',') + ') VALUES (' + values.join(',') + ');\n');
      }
    }
    await write('SET FOREIGN_KEY_CHECKS=1;\n'); await db.commit(); output.end(); await finished;
  } catch (error) { output.destroy(); throw error; } finally { await db.end(); }
}

// Stream SQL from both our backups and the existing mysqldump format; never enable multi-statements or LOCAL INFILE.
export async function* sqlStatements(path) {
  let statement = '', quote = '', escaped = false, comment = '', previous = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 65536 })) {
    for (const char of chunk) {
      statement += char;
      if (statement.length > 64 * 1024 ** 2) throw Error('备份中的 SQL 语句过大');
      if (comment === 'line') { if (char === '\n') comment = ''; }
      else if (comment === 'block') { if (previous === '*' && char === '/') comment = ''; }
      else if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; }
      else if (char === "'" || char === '"' || char === '`') quote = char;
      else if (previous === '/' && char === '*') comment = 'block';
      else if ((previous === '-' && char === '-') || char === '#') comment = 'line';
      else if (char === ';') { yield statement; statement = ''; }
      previous = char;
    }
  }
  if (quote || comment === 'block') throw Error('备份中的 SQL 不完整');
  if (statement.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) yield statement;
}
export async function importDatabase(path, values) {
  // Validate the whole stream before dropping the destination tables.
  for await (const sql of sqlStatements(path)) if (/^\s*DELIMITER\b/im.test(sql)) throw Error('不支持包含存储过程的备份');
  const db = await connectDatabase(values);
  try {
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    const [tables] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'");
    for (const table of tables) await db.query('DROP TABLE ' + identifier(table.TABLE_NAME));
    for await (const sql of sqlStatements(path)) await db.query(sql);
  } finally { await db.end(); }
}
