import { auth } from '@/auth';
import { getCache, setCache } from '@/lib/cache';
import {
    AcademicPrompet,
    DeepQueryPrompt,
    MoreQuestionsPrompt,
    NewsPrompt,
} from '@/lib/prompt';
import {
    AskMode,
    CachedResult,
    TextSource,
    ImageSource,
    SearchCategory,
} from '@/lib/types';
import { NextRequest, NextResponse } from 'next/server';
import util from 'util';

import { Ratelimit } from '@upstash/ratelimit';
import { incSearchCount, RATE_LIMIT_KEY, redisDB } from '@/lib/db';
import {
    getSearchEngine,
    getVectorSearch,
    IMAGE_LIMIT,
} from '@/lib/search/search';
import { GPT_4o_MIMI, validModel } from '@/lib/model';
import { logError } from '@/lib/log';
import { getLLMChat, Message, StreamHandler } from '@/lib/llm/llm';
import { openaiChat } from '@/lib/llm/openai';

const ratelimit = new Ratelimit({
    redis: redisDB,
    limiter: Ratelimit.slidingWindow(3, '1 d'),
    prefix: RATE_LIMIT_KEY,
    analytics: false,
});

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    const session = await auth();
    let userId = '';
    if (session) {
        userId = session.user.id;
    } else {
        const ip = (req.headers.get('x-forwarded-for') ?? '127.0.0.1').split(
            ',',
        )[0];

        const { success } = await ratelimit.limit(ip);
        if (!success) {
            return NextResponse.json(
                {
                    error: 'Rate limit exceeded',
                },
                { status: 429 },
            );
        }
    }
    const { query, useCache, mode, model, source } = await req.json();

    if (!validModel(model)) {
        return NextResponse.json(
            {
                error: 'Please choose a valid model',
            },
            { status: 400 },
        );
    }

    try {
        const readableStream = new ReadableStream({
            async start(controller) {
                await ask(
                    query,
                    useCache,
                    userId,
                    (message: string | null, done: boolean) => {
                        if (done) {
                            controller.close();
                        } else {
                            const payload = `data: ${message} \n\n`;
                            controller.enqueue(payload);
                        }
                    },
                    mode,
                    model,
                    source,
                );
            },
            cancel() {
                console.log('Stream canceled by client');
            },
        });
        return new Response(readableStream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
            },
        });
    } catch (error) {
        logError(error, 'search');
        return NextResponse.json({ error: `${error}` }, { status: 500 });
    }
}

async function ask(
    query: string,
    useCache: boolean,
    userId?: string,
    onStream?: (...args: any[]) => void,
    mode: AskMode = 'simple',
    model = GPT_4o_MIMI,
    source = SearchCategory.ALL,
) {
    let cachedResult: CachedResult | null = null;
    if (useCache) {
        query = query.trim();
        let cachedResult: CachedResult = await getCache(model + source + query);
        if (cachedResult) {
            const { webs, images, answer, related } = cachedResult;
            await streamResponse(
                { sources: webs, images, answer, related },
                onStream,
            );
            onStream?.(null, true);

            if (userId) {
                // Without awaiting incSearchCount to avoid blocking response time
                incSearchCount(userId).catch((error) => {
                    console.error(
                        `Failed to increment search count for user ${userId}:`,
                        error,
                    );
                });
            }
            return;
        }
    }

    let texts: TextSource[] = [];
    let images: ImageSource[] = [];
    const searchOptions = {
        categories: [source],
    };

    if (userId && source === SearchCategory.ALL) {
        const vectorSearchPromise = getVectorSearch(userId).search(query);
        const webSearchPromise = getSearchEngine(searchOptions).search(query);

        const [vectorResponse, webResponse] = await Promise.all([
            vectorSearchPromise,
            webSearchPromise,
        ]);

        ({ texts } = vectorResponse);

        const { texts: webTexts, images: webImages = [] } = webResponse;

        texts = [...texts, ...webTexts];
        images = [...images, ...webImages];
    }

    if (!texts.length) {
        ({ texts, images } =
            await getSearchEngine(searchOptions).search(query));
    }

    await streamResponse({ sources: texts, images }, onStream);

    let fullAnswer = '';
    const llmAnswerPromise = getLLMAnswer(
        source,
        model,
        query,
        texts,
        mode,
        (msg) => {
            fullAnswer += msg;
            onStream?.(JSON.stringify({ answer: msg }));
        },
    );

    const imageFetchPromise =
        images.length === 0
            ? getSearchEngine({
                  categories: [SearchCategory.IMAGES],
              })
                  .search(query)
                  .then((results) =>
                      results.images
                          .filter((img) => img.image.startsWith('https'))
                          .slice(0, IMAGE_LIMIT),
                  )
            : Promise.resolve(images);

    // step 2: get llm answer and step 3: get images sources
    const [, fetchedImages] = await Promise.all([
        llmAnswerPromise,
        imageFetchPromise,
    ]);

    if (!images.length) {
        images = fetchedImages;
        await streamResponse({ images: fetchedImages }, onStream);
    }

    let fullRelated = '';
    // step 4: get related questions
    await getRelatedQuestions(query, texts, (msg) => {
        fullRelated += msg;
        onStream?.(JSON.stringify({ related: msg }));
    });

    cachedResult = {
        webs: texts,
        images: images,
        answer: fullAnswer,
        related: fullRelated,
    };

    if (userId) {
        // Without awaiting incSearchCount and setCache to avoid blocking response time
        incSearchCount(userId).catch((error) => {
            console.error(
                `Failed to increment search count for user ${userId}:`,
                error,
            );
        });
    }

    setCache(model + source + query, cachedResult).catch((error) => {
        console.error(`Failed to set cache for query ${query}:`, error);
    });
    onStream?.(null, true);
}

async function streamResponse(
    data: Record<string, any>,
    onStream?: (...args: any[]) => void,
) {
    for (const [key, value] of Object.entries(data)) {
        onStream?.(JSON.stringify({ [key]: value }));
    }
}

async function getLLMAnswer(
    source: SearchCategory,
    model: string,
    query: string,
    contexts: TextSource[],
    mode: AskMode = 'simple',
    onStream: StreamHandler,
) {
    try {
        const { messages } = paramsFormatter(
            source,
            query,
            mode,
            contexts,
            'answer',
        );
        await getLLMChat(model).chatStream(
            messages,
            (msg: string | null, done: boolean) => {
                onStream?.(msg, done);
            },
            model,
        );
    } catch (err: any) {
        logError(err, 'llm');
        onStream?.(`Some errors seem to have occurred, plase retry`, true);
    }
}

async function getRelatedQuestions(
    query: string,
    contexts: TextSource[],
    onStream: StreamHandler,
) {
    try {
        const { messages } = paramsFormatter(
            SearchCategory.ALL,
            query,
            undefined,
            contexts,
            'related',
        );
        await openaiChat.chatStream(messages, onStream, GPT_4o_MIMI);
    } catch (err) {
        logError(err, 'llm');
        return [];
    }
}

function choosePrompt(source: SearchCategory, type: 'answer' | 'related') {
    if (source === SearchCategory.ACADEMIC) {
        return AcademicPrompet;
    }
    if (source === SearchCategory.NEWS) {
        return NewsPrompt;
    }
    if (type === 'answer') {
        return DeepQueryPrompt;
    }
    if (type === 'related') {
        return MoreQuestionsPrompt;
    }
    return DeepQueryPrompt;
}

function paramsFormatter(
    source: SearchCategory,
    query: string,
    mode: AskMode = 'simple',
    contexts: any[],
    type: 'answer' | 'related',
) {
    const context = contexts
        .map((item, index) => `[citation:${index + 1}] ${item.content}`)
        .join('\n\n');
    let prompt = choosePrompt(source, type);

    const system = util.format(prompt, context);
    const messages: Message[] = [
        {
            role: 'user',
            content: `${system} ${query}`,
        },
    ];
    return {
        messages,
    };
}
