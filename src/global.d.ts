declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode: "read" | "readwrite";
  }

  interface FileSystemHandle {
    queryPermission(opts?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(opts?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }

  interface Window {
    showOpenFilePicker(options?: {
      multiple?: boolean;
      types?: Array<{
        description?: string;
        accept?: Record<string, string[]>;
      }>;
      excludeAcceptAllOption?: boolean;
    }): Promise<FileSystemFileHandle[]>;
  }
}

export {};