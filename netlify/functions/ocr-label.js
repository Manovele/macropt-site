exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing GOOGLE_VISION_API_KEY" })
      };
    }

    const { image } = JSON.parse(event.body || "{}");
    if (!image || !image.startsWith("data:image")) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid image" })
      };
    }

    const base64 = image.split(",")[1];

    const visionResp = await fetch(
      "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: base64 },
            features: [{ type: "TEXT_DETECTION" }]
          }]
        })
      }
    );

    if (!visionResp.ok) {
      const txt = await visionResp.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: txt })
      };
    }

    const visionJson = await visionResp.json();
    const rawText =
      visionJson?.responses?.[0]?.fullTextAnnotation?.text || "";

    const lines = rawText
      .split("\n")
      .map(l => l.trim().toLowerCase())
      .filter(Boolean);

    const readAfterLabel = (label, { skipEnergy = false } = {}) => {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(label)) {
          for (let j = i + 1; j <= i + 3; j++) {
            const l = lines[j];
            if (!l) continue;
            if (skipEnergy && (l.includes("kcal") || l.includes("kj") || l.includes("energia"))) continue;
            const m = l.match(/(\d+(?:[.,]\d+)?)/);
            if (m) return parseFloat(m[1].replace(",", "."));
          }
        }
      }
      return null;
    };

    const per100 = {
      c: readAfterLabel("carboidrati", { skipEnergy: true }),
      p: readAfterLabel("proteine", { skipEnergy: true }),
      f: readAfterLabel("grassi", { skipEnergy: true }),
      kcalLabel: readAfterLabel("kcal")
    };

    const found = ["c", "p", "f"].filter(k => per100[k] != null).length;

    return {
      statusCode: 200,
      body: JSON.stringify({
        per100: found ? per100 : null,
        confidence: found === 3 ? 0.95 : 0.4,
        rawText
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(e) })
    };
  }
};
