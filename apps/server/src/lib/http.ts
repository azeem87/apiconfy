/** The media type of a Content-Type header value — parameters and case removed. */
export function mediaType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

export async function parseResponseBody(response: Response): Promise<unknown> {
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return response.json();
  }
  return response.text();
}
