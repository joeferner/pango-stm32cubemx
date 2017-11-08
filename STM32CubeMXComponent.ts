import {Component} from "@pango/components";
import {ProjectOptions} from "pango";
import {STM32CubeMXComponentOptions} from "./STM32CubeMXComponentOptions";
import {STM32CubeMXBuildTarget} from "./STM32CubeMXBuildTarget";

export const COMPONENT_NAME = 'stm32cubemx';

export class STM32CubeMXComponent implements Component {
    name?: string;

    constructor() {
        this.name = COMPONENT_NAME;
    }

    init(projectOptions: ProjectOptions) {
        const componentOptions: STM32CubeMXComponentOptions = projectOptions.components[this.name];
        componentOptions.targets.build = new STM32CubeMXBuildTarget();
        return Promise.resolve();
    }
}