export function isJsonContentType(headers: Headers): boolean {
  const ct = headers.get('content-type') ?? '';
  return ct.includes('application/json');
}

export function isFormUrlEncoded(headers: Headers): boolean {
  const ct = headers.get('content-type') ?? '';
  return ct.includes('application/x-www-form-urlencoded');
}

export async function parseResponseBody(response: Response): Promise<unknown> {
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return response.json();
  }
  return response.text();
}
