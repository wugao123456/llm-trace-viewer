/**
 * 文件句柄存储模块
 * 使用 IndexedDB 持久化 FileSystemFileHandle，实现快速重新加载功能
 * 
 * 核心流程：
 * 1. 用户通过 File System Access API 选择文件
 * 2. 将文件句柄保存到 IndexedDB
 * 3. 下次访问时直接从 IndexedDB 加载句柄并读取文件
 * 4. 无需用户再次选择文件
 */

const DB_NAME = "llm-trace-viewer";
const DB_VERSION = 1;
const STORE_NAME = "file-handles";

/**
 * 打开 IndexedDB 数据库连接
 * 如果数据库不存在则创建，版本升级时创建对象存储
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // 数据库首次创建或版本升级时触发
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 将文件句柄保存到 IndexedDB
 * @param key - 存储键名
 * @param handle - FileSystemFileHandle 对象
 */
export async function saveFileHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    db.close();
  });
}

/**
 * 从 IndexedDB 加载文件句柄
 * @param key - 存储键名
 * @returns FileSystemFileHandle 或 null（未找到时）
 */
export async function loadFileHandle(key: string): Promise<FileSystemFileHandle | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    db.close();
  });
}

/**
 * 从 IndexedDB 删除文件句柄
 * @param key - 存储键名
 */
export async function removeFileHandle(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    db.close();
  });
}

/**
 * 通过 FileSystemFileHandle 读取文件
 * 使用 File System Access API 的 getFile() 方法获取 File 对象
 */
export async function readFileFromHandle(handle: FileSystemFileHandle): Promise<File> {
  return await handle.getFile();
}