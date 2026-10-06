/**
 * 从 axios/Error/(unknown) 中提取用户可读的错误信息。
 * 调用方可传入已国际化的兜底文案；未传时使用中性英文兜底。
 */
export function getErrorMessage(error: unknown, fallback = "Request failed"): string {
  const candidate = error as {
    response?: { data?: { error?: string } };
    message?: string;
  };
  return candidate?.response?.data?.error || candidate?.message || fallback;
}
