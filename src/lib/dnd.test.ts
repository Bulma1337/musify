import { moveItems } from "./dnd";

describe("moveItems", () => {
  const list = ["a", "b", "c", "d", "e"];

  it("moves one item down and up", () => {
    expect(moveItems(list, [1], 4)).toEqual(["a", "c", "d", "b", "e"]);
    expect(moveItems(list, [3], 0)).toEqual(["d", "a", "b", "c", "e"]);
  });

  it("moves several items keeping their order", () => {
    expect(moveItems(list, [0, 2], 5)).toEqual(["b", "d", "e", "a", "c"]);
    expect(moveItems(list, [3, 4], 1)).toEqual(["a", "d", "e", "b", "c"]);
  });

  it("dropping in place changes nothing", () => {
    expect(moveItems(list, [2], 2)).toEqual(list);
    expect(moveItems(list, [2], 3)).toEqual(list);
  });
});
