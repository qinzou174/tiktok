import assert from "node:assert/strict";
import { isSuccessfulParserResponse, normalizeParserResult, parserFailureMessage } from "../parser-response.mjs";

const modernVideo = {
  status: "success", task_id: "task-1",
  data: {
    kind: "video", content_id: "1001", title: "video title", author: { nickname: "video author" },
    media: {
      video: { url: "https://media/video.mp4" }, covers: [{ url: "https://media/cover.jpg" }], images: [],
      streams: [{ url: "https://media/low.mp4", bitrate: 100 }, { url: "https://media/high.mp4", bitrate: 500 }],
    },
    music: { play_url: "https://media/music.mp3" },
  },
};
assert.equal(isSuccessfulParserResponse(modernVideo), true);
assert.deepEqual(normalizeParserResult(modernVideo), {
  type: "video", videoId: "1001", title: "video title", author: "video author",
  authorInfo: { nickname: "video author" }, coverUrl: "https://media/cover.jpg",
  audioUrl: "https://media/music.mp3", videoUrl: "https://media/video.mp4",
  videoUrlHd: "https://media/high.mp4", images: [], cleanImages: [], livePhotoVideos: [],
});

const modernLivePhoto = {
  status: "success",
  data: {
    kind: "image_album", is_live_photo: true, content_id: "1002", description: "live title",
    author: { nickname: "live author" }, music: {},
    media: { covers: [], streams: [], images: [
      { url: "https://media/1.jpg", live_photo_url: "https://media/1.mp4" },
      { urls: ["https://media/2.jpg"], live_photo_urls: ["https://media/2.mp4"] },
    ] },
  },
};
const live = normalizeParserResult(modernLivePhoto);
assert.equal(live.type, "live_photo");
assert.deepEqual(live.images, ["https://media/1.jpg", "https://media/2.jpg"]);
assert.deepEqual(live.livePhotoVideos, ["https://media/1.mp4", "https://media/2.mp4"]);

const legacy = normalizeParserResult({
  success: true, type: "image", video_id: "1003", title: "legacy", author: "legacy author",
  images: ["https://media/legacy.jpg"], images_no_watermark: [],
});
assert.equal(isSuccessfulParserResponse({ success: true }), true);
assert.equal(legacy.videoId, "1003");
assert.deepEqual(legacy.images, ["https://media/legacy.jpg"]);
assert.equal(parserFailureMessage({ data: { message: "nested failure" } }, "fallback"), "nested failure");
assert.equal(isSuccessfulParserResponse({ status: "success", data: null }), false);

console.log("parser-response-test: ok");
