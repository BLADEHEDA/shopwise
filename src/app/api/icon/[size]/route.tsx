import { ImageResponse } from "next/og";
import { getBrandServer } from "@/lib/brand-server";

export const revalidate = 300;

// App icon generated from the brand config: uploaded icon if set,
// otherwise the product name's initial on the primary colour.
export async function GET(req: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size: s } = await params;
  const size = Math.min(1024, Math.max(16, parseInt(s, 10) || 192));
  const maskable = new URL(req.url).searchParams.has("maskable");
  const brand = await getBrandServer();

  if (brand.icon_url) {
    return new ImageResponse(
      (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#fff" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={brand.icon_url} width={maskable ? size * 0.7 : size} height={maskable ? size * 0.7 : size} alt="" />
        </div>
      ),
      { width: size, height: size },
    );
  }
  const letter = brand.product_name.trim().charAt(0).toUpperCase() || "S";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: brand.primary_color, borderRadius: maskable ? 0 : size * 0.22 }}>
        <div style={{ color: "#fff", fontSize: size * (maskable ? 0.42 : 0.56), fontWeight: 700, lineHeight: 1 }}>{letter}</div>
      </div>
    ),
    { width: size, height: size },
  );
}
