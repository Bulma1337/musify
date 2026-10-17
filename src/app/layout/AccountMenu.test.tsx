import { fireEvent, screen } from "@testing-library/react";
import type { ServerConfig } from "@/api/provider";
import { useSession } from "@/api/session";
import { usePlayer } from "@/player/store";
import { fakeTracks } from "@/test/fakeProvider";
import { renderPage } from "@/test/renderPage";
import { AccountMenu } from "./AccountMenu";

/** Radix menus open on pointerdown + keyboard; jsdom needs the pointer events spelled out. */
function openMenu() {
  const trigger = screen.getByRole("button", { name: /konto|account/i });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("AccountMenu", () => {
  it("lists the servers, switches between them and clears the old server's queue", async () => {
    renderPage(<AccountMenu />);
    const first = useSession.getState().servers[0]!;
    const second: ServerConfig = {
      ...first,
      id: "second",
      name: "Zweiter Server",
      url: "https://two.example.com",
    };
    const switchServer = vi.fn(async () => {});
    useSession.setState({ servers: [first, second], switchServer });
    usePlayer.getState().playTracks(fakeTracks.slice(0, 2), 0, { type: "album", id: "al1", name: "A" });

    openMenu();
    fireEvent.click(await screen.findByText("Zweiter Server"));
    expect(switchServer).toHaveBeenCalledWith("second");
    expect(usePlayer.getState().current).toBeNull();
    expect(usePlayer.getState().contextItems).toHaveLength(0);
  });

  it("opens the add-server form", async () => {
    renderPage(<AccountMenu />);
    openMenu();
    fireEvent.click(await screen.findByText(/server hinzufügen|add server/i));
    expect(useSession.getState().adding).toBe(true);
  });
});
