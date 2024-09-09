import 'server-only';

import { SearchOptions, SearchResult, SearchSource } from '@/lib/search/search';
import { ImageSource, SearchCategory, TextSource } from '@/lib/types';
import { logError } from '@/lib/log';
import { fetchWithTimeout } from '@/lib/server-utils';
import { SERPER_API_KEY } from '@/lib/env';

const serperUrl = 'https://google.serper.dev/';

function formatUrl(options: SearchOptions) {
    if (options.categories && options.categories.length > 0) {
        const category = options.categories[0];
        switch (category) {
            case SearchCategory.IMAGES:
                return `${serperUrl}images`;
            case SearchCategory.NEWS:
                return `${serperUrl}news`;
            default:
                return `${serperUrl}search`;
        }
    }
    return `${serperUrl}search`;
}

export class SerperSearch implements SearchSource {
    private options: SearchOptions;

    constructor(params?: SearchOptions) {
        this.options = params || {};
    }

    async search(query: string): Promise<SearchResult> {
        const url = formatUrl(this.options);
        // console.log('searchSerper:', url, query);

        let texts: TextSource[] = [];
        let images: ImageSource[] = [];
        let jsonResponse;
        try {
            const response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'X-API-KEY': SERPER_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ q: query.slice(0, 2000) }),
            });

            if (!response.ok) {
                const errorDetails = await response.text();
                throw new Error(`Fetch failed with status code: ${response.status} and Details: ${errorDetails}`);
            }

            jsonResponse = await response.json();
            if (jsonResponse.knowledgeGraph) {
                const url = jsonResponse.knowledgeGraph.descriptionLink || jsonResponse.knowledgeGraph.website;
                const snippet = jsonResponse.knowledgeGraph.description;
                if (url && snippet) {
                    texts.push({
                        title: jsonResponse.knowledgeGraph.title || '',
                        url: url,
                        content: snippet,
                    });
                }
            }

            if (jsonResponse.answerBox) {
                const url = jsonResponse.answerBox.link;
                const snippet = jsonResponse.answerBox.snippet || jsonResponse.answerBox.answer;
                if (url && snippet) {
                    texts.push({
                        title: jsonResponse.answerBox.title || '',
                        url: url,
                        content: snippet,
                    });
                }
            }

            if (jsonResponse.images) {
                images = images.concat(
                    jsonResponse.images.map((i: any) => ({
                        title: i.title,
                        url: i.link,
                        image: i.imageUrl,
                    })),
                );
            }

            if (jsonResponse.organic) {
                texts = texts.concat(
                    jsonResponse.organic.map((c: any) => ({
                        title: c.title,
                        url: c.link,
                        content: c.snippet || '',
                    })),
                );
            }

            if (jsonResponse.news) {
                texts = texts.concat(
                    jsonResponse.news.map((c: any) => ({
                        title: c.title,
                        url: c.link,
                        content: c.snippet || '',
                    })),
                );
            }
            return { texts, images };
        } catch (error) {
            logError(error, 'search-serper');
            return { texts, images };
        }
    }
}
