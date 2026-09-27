function mediaUrl(value) {
  if (typeof value === "string" && value.startsWith("http")) return value;
  if (Array.isArray(value)) return value.find((url) => typeof url === "string" && url.startsWith("http")) || null;
  if (!value || typeof value !== "object") return null;
  if (typeof value.url === "string" && value.url.startsWith("http")) return value.url;
  return Array.isArray(value.urls) ? value.urls.find((url) => typeof url === "string" && url.startsWith("http")) || null : null;
}

function mediaUrls(values) {
  return Array.isArray(values) ? values.map(mediaUrl).filter(Boolean) : [];
}

export function isSuccessfulParserResponse(payload) {
  return payload?.success === true || Boolean(payload?.status === "success" && payload?.data && typeof payload.data === "object");
}

export function parserFailureMessage(payload, fallback) {
  return String(payload?.message || payload?.msg || payload?.error || payload?.data?.message || payload?.data?.msg || fallback);
}

export function normalizeParserResult(payload) {
  if (payload?.status !== "success" || !payload?.data || typeof payload.data !== "object") {
    const images = Array.isArray(payload?.images) ? payload.images : [];
    const cleanImages = Array.isArray(payload?.images_no_watermark) ? payload.images_no_watermark : [];
    return {
      type: payload?.type || "unknown", videoId: String(payload?.video_id || ""),
      title: payload?.title || "未命名作品", author: payload?.author || payload?.author_info?.nickname || "未知作者",
      authorInfo: payload?.author_info || null, coverUrl: payload?.cover_url || null,
      audioUrl: payload?.audio_url || null, videoUrl: payload?.video_url || null,
      videoUrlHd: payload?.video_url_hd || null, images, cleanImages, livePhotoVideos: [],
    };
  }

  const data = payload.data;
  const media = data.media && typeof data.media === "object" ? data.media : {};
  const images = mediaUrls(media.images);
  const livePhotoVideos = Array.isArray(media.images)
    ? media.images.map((image) => mediaUrl(image?.live_photo_url) || mediaUrl(image?.live_photo_urls)).filter(Boolean)
    : [];
  const streams = Array.isArray(media.streams) ? media.streams.filter((stream) => mediaUrl(stream) && stream?.watermark !== true) : [];
  const bestStream = streams.sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0];
  const isLivePhoto = data.is_live_photo === true || livePhotoVideos.length > 0;
  const type = isLivePhoto ? "live_photo" : data.kind === "video" ? "video" : data.kind === "image_album" ? "image" : String(data.kind || "unknown");
  return {
    type, videoId: String(data.content_id || ""), title: data.title || data.description || "未命名作品",
    author: data.author?.nickname || "未知作者", authorInfo: data.author || null,
    coverUrl: mediaUrl(media.covers?.[0]), audioUrl: mediaUrl(data.music?.play_url),
    videoUrl: mediaUrl(media.video), videoUrlHd: mediaUrl(bestStream), images, cleanImages: images, livePhotoVideos,
  };
}
